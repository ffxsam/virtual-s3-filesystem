import path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  StorageClass,
  type S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import createDebug from 'debug';

type S3Url = `s3://${string}/${string}`;
type S3Location = { bucket: string; key: string };

type FileKeyMap = {
  [key: string]: S3Url | S3Location;
};

type FilePathMap = {
  [key: string]: {
    path: string;
    mimeType?: string;
    modified: boolean;
    /** Experimental feature */
    watcher?: fs.FSWatcher;
  };
};

type CommitOptions = {
  /** Commit to a specific bucket */
  bucket: string;
  /** Commit to a specific key */
  key: string;
  /** MIME type */
  mimeType?: string;
};

type DestroyOptions = {
  /**
   * Whether to delete all committed files from S3 buckets.
   * @default false
   */
  deleteCommitted?: boolean;
};

export type VfsFile = {
  /**
   * Commits the local file to S3.
   */
  commit: (options?: CommitOptions) => Promise<void>;

  /**
   * Deletes the local file. This is useful if you want to save space on
   * the Lambda container.
   */
  delete: () => Promise<void>;

  /**
   * Gets the local path of the file. If the file doesn't exist locally,
   * it will be downloaded from S3.
   * @returns The local path of the file
   */
  getPath: () => Promise<string>;
};

/**
 * To enable debug logging, set the DEBUG environment variable to include
 * 'vs3fs' (e.g. 'DEBUG=vs3fs,other1,other2').
 */
const debug = createDebug('vs3fs');

class VirtualS3FileSystem {
  private committedObjects: S3Location[] = [];
  private fileKeyMap: { [key: string]: S3Location } = {};
  private filePathMap: FilePathMap = {};
  private s3: S3Client;
  private storageClass: StorageClass;
  private systemTmp: string;
  private tmpFolder = '';
  private tmpAvailableBytes = 0;

  constructor({
    s3Client,
    storageClass = 'STANDARD',
    tmpFolder = '/tmp',
  }: {
    /**
     * S3 client to use for all S3 operations.
     *
     * @example
     * const s3Client = new S3Client({ region: 'us-east-1' });
     * const vfs = new VirtualS3FileSystem({ s3Client });
     */
    s3Client: S3Client;
    /**
     * The S3 storage class to use when saving files to S3.
     * 'INTELLIGENT_TIERING' is recommended for most use cases.
     * @default 'STANDARD'
     */
    storageClass?: StorageClass;
    /**
     * Folder to use for temporary files.
     * @default '/tmp'
     */
    tmpFolder?: string;
  }) {
    this.s3 = s3Client;
    this.storageClass = storageClass;
    this.systemTmp = tmpFolder;
  }

  /**
   * Initializes the virtual filesystem.
   * @param fileKeyMap A map of cache keys to S3 objects
   * @example
   * await vfs.init({
   *   fileA: 's3://my-bucket/path/to/fileA',
   *   fileB: {
   *     bucket: 'another-bucket',
   *     key: 'path/to/fileB',
   *   }
   * })
   */
  public async init(fileKeyMap: FileKeyMap): Promise<void> {
    /**
     * We have to clear out these maps here and not in the constructor, because
     * the constructor is called once per Lambda cold start. We don't want key
     * and path maps to persist across invocations.
     */
    this.fileKeyMap = {};
    this.filePathMap = {};

    // Convert fileKeyMap to all S3Locations
    Object.keys(fileKeyMap).forEach((key) => {
      const s3Url = fileKeyMap[key];

      if (typeof s3Url === 'string') {
        this.fileKeyMap[key] = this.convertS3UrlToLocation(s3Url);
      } else {
        this.fileKeyMap[key] = s3Url;
      }
    });

    this.tmpFolder = `${this.systemTmp}/vs3fs-${randomUUID()}`;
    await fsPromises.mkdir(this.tmpFolder, { recursive: true });

    const statFs = await fsPromises.statfs(this.systemTmp);

    this.tmpAvailableBytes = statFs.bsize * statFs.bavail;
  }

  /**
   * Destroys the virtual filesystem and deletes all local files.
   */
  public async destroy(options: DestroyOptions = {}): Promise<void> {
    Object.values(this.filePathMap).forEach((file) => file.watcher?.close());
    await fsPromises.rm(this.tmpFolder, { force: true, recursive: true });

    if (options.deleteCommitted) {
      await this.deleteCommittedFromS3();
    }

    this.committedObjects = [];
    this.filePathMap = {};
    this.fileKeyMap = {};
  }

  /**
   * Checks if a file exists in the virtual filesystem. Note that this only
   * checks for the existence of the cache key, not the actual file.
   * @param key Cache key for the file
   * @returns Whether the file exists
   */
  public exists(key: string): boolean {
    return !!this.fileKeyMap[key];
  }

  /**
   * Gets a file from the virtual filesystem and prepares to run a specified
   * action (chainable methods available).
   * @param key Cache key for the file
   * @returns A VfsFile object
   */
  public file(key: string): VfsFile {
    return {
      commit: async (options = { bucket: '', key: '' }) => {
        this.checkInit();

        if (!this.filePathMap[key]) {
          await this.throwError(`Cannot commit nonexistent file "${key}"`);
        }

        return new Promise((resolve, reject) => {
          const stream = fs.createReadStream(this.filePathMap[key].path);

          stream.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') {
              this.throwError(
                `Local file "${this.filePathMap[key].path}" not found`,
                err
              ).catch((err) => reject(err));
            }

            this.throwError(err.message, err).catch((err) => reject(err));
          });
          stream.on('ready', async () => {
            debug(`Uploading ${key} to ${this.getS3Url(key)}...`);

            try {
              await this.s3.send(
                new PutObjectCommand({
                  Bucket: options.bucket || this.fileKeyMap[key].bucket,
                  Key: options.key || this.fileKeyMap[key].key,
                  Body: stream,
                  ContentType:
                    options.mimeType || this.filePathMap[key].mimeType,
                  StorageClass: this.storageClass,
                })
              );
            } catch (e: unknown) {
              const err = e as Error;

              this.throwError(
                `${err.name} error while saving ${key} to ` +
                  this.getS3Url(key),
                err
              ).catch((err) => reject(err));
            }
          });
          stream.on('close', () => {
            debug(`Successfully uploaded ${key} to ${this.getS3Url(key)}`);

            this.committedObjects.push({
              bucket: options.bucket || this.fileKeyMap[key].bucket,
              key: options.key || this.fileKeyMap[key].key,
            });
            this.filePathMap[key].modified = false;
            resolve();
          });
        });
      },
      delete: async () => {
        this.filePathMap[key].watcher?.close();
        await fsPromises.rm(this.filePathMap[key].path, { force: true });
      },
      getPath: async () => {
        this.checkInit();

        if (!this.fileKeyMap[key]) {
          await this.throwError(`No cache key found for "${key}"`);
        }

        if (!this.filePathMap[key]) {
          const { ext } = path.parse(this.fileKeyMap[key].key);
          const fullPath = `${this.tmpFolder}/${randomUUID()}${ext}`;
          let response: GetObjectCommandOutput;
          let sizeInBytes: number;

          try {
            response = await this.s3.send(
              new HeadObjectCommand({
                Bucket: this.fileKeyMap[key].bucket,
                Key: this.fileKeyMap[key].key,
              })
            );

            /**
             * ContentLength shouldn't be undefined, but if it is, we'll just
             * grab the file anyway.
             */
            sizeInBytes = response.ContentLength || 0;

            if (sizeInBytes > this.tmpAvailableBytes) {
              await this.throwError(
                `Not enough space to cache file "${this.fileKeyMap[key]}" ` +
                  `(${sizeInBytes} bytes needed, ${this.tmpAvailableBytes} ` +
                  'bytes available)'
              );
            }

            response = await this.s3.send(
              new GetObjectCommand({
                Bucket: this.fileKeyMap[key].bucket,
                Key: this.fileKeyMap[key].key,
              })
            );
          } catch (e: unknown) {
            const err = e as Error;

            await this.throwError(
              `${err.name} error while getting ${this.getS3Url(key)}`,
              err
            );

            throw e; // this won't actually happen, it's just to satisfy TS
          }

          const mimeType = response.ContentType;
          const fileStream = fs.createWriteStream(fullPath);

          await new Promise((resolve, reject) => {
            response.Body &&
              (response.Body as Readable)
                .pipe(fileStream)
                .on('finish', resolve)
                .on('error', reject);
          });

          this.tmpAvailableBytes -= sizeInBytes;
          this.filePathMap[key] = {
            path: fullPath,
            mimeType,
            modified: false,
          };
          this.filePathMap[key].watcher = fs.watch(
            this.filePathMap[key].path,
            () => {
              this.filePathMap[key].modified = true;
            }
          );
        }

        return this.filePathMap[key].path;
      },
    };
  }

  /**
   * Commits all modified files to S3. EXPERIMENTAL FEATURE, due to fs.watch not
   * being completely reliable. Files created via createFutureFile() will be
   * committed.
   */
  public async commitChanged(): Promise<void> {
    this.checkInit();

    await Promise.all(
      Object.keys(this.filePathMap).map(async (key) => {
        if (this.filePathMap[key].modified) {
          await this.file(key).commit();
        }
      })
    );
  }

  /**
   * Creates a placeholder in the cache for a file that will be created in the
   * future.
   * @param newKey Cache key for the new file
   * @param s3Object S3 location to sync to
   * @param mimeType Optional MIME type of the file
   */
  public createFutureFile(
    newKey: string,
    s3Object: S3Url | S3Location,
    mimeType?: string
  ): VfsFile {
    this.checkInit();

    const s3Location =
      typeof s3Object === 'string'
        ? this.convertS3UrlToLocation(s3Object)
        : s3Object;
    const { ext } = path.parse(s3Location.key);
    const fullPath = `${this.tmpFolder}/${randomUUID()}${ext}`;

    this.fileKeyMap[newKey] = s3Location;
    this.filePathMap[newKey] = {
      path: fullPath,
      mimeType,
      /**
       * Default future files to modified, so they'll be committed if
       * commitChanged() is called.
       */
      modified: true,
    };

    /**
     * TODO: Somehow watch for future files
     * Would be super cool if we could detect when this file gets created, but
     * you can't watch a nonexistent file, and watching the whole tmp folder
     * seems inconsistent (if the file is created too quickly after the watcher
     * is created, it doesn't detect the new file).
     */

    return this.file(newKey);
  }

  private checkInit() {
    if (!this.tmpFolder) {
      this.throwError('Not initialized; must call init() before using');
    }
  }

  private convertS3UrlToLocation(s3Url: S3Url): S3Location {
    const { host, pathname } = new URL(s3Url);

    if (!host || !pathname) {
      this.throwError(`Invalid S3 URL: ${s3Url}`);
    }

    return { bucket: host, key: pathname.slice(1) };
  }

  /**
   * TODO: Make this handle AWS's 1000-key limit. We'll have to write an
   * intelligent chunk function that groups keys by bucket.
   */
  private async deleteCommittedFromS3() {
    this.checkInit();

    await Promise.all(
      this.committedObjects.map((s3Location) =>
        this.s3.send(
          new DeleteObjectCommand({
            Bucket: s3Location.bucket,
            Key: s3Location.key,
          })
        )
      )
    );
  }

  private getS3Url(key: string) {
    return `s3://${this.fileKeyMap[key].bucket}/${this.fileKeyMap[key].key}`;
  }

  private async throwError(errMsg: string, originalError?: Error) {
    await this.destroy();
    throw new Error(
      '[VirtualS3FileSystem] ' + errMsg,
      originalError && {
        cause: originalError,
      }
    );
  }
}

export default VirtualS3FileSystem;
