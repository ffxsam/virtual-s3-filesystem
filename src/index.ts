import path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  type S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

type FilePathMap = {
  [key: string]: {
    path: string;
    mimeType?: string;
    modified: boolean;
  };
};

export type VfsFile = {
  /**
   * Commits the local file to S3.
   */
  commit: () => Promise<void>;

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

class VirtualS3FileSystem {
  private bucket: string | undefined = undefined;
  private fileKeyMap: Record<string, string> = {};
  private filePathMap: FilePathMap = {};
  private fileWatchers: fs.FSWatcher[] = []; // Experimental for now
  private s3: S3Client;
  private systemTmp: string;
  private tmpFolder = '';
  private tmpAvailableBytes = 0;

  constructor({
    s3Client,
    tmpFolder = '/tmp',
  }: {
    s3Client: S3Client;
    tmpFolder?: string;
  }) {
    this.s3 = s3Client;
    this.systemTmp = tmpFolder;
  }

  public async init(bucket: string, fileKeyMap: Record<string, string>) {
    this.bucket = bucket;
    this.fileKeyMap = fileKeyMap;
    this.tmpFolder = `${this.systemTmp}/vs3fs-${randomUUID()}`;

    await fsPromises.mkdir(this.tmpFolder, { recursive: true });

    const statFs = await fsPromises.statfs(this.systemTmp);

    this.tmpAvailableBytes = statFs.bsize * statFs.bavail;
  }

  /**
   * Destroys the virtual filesystem and deletes all local files.
   */
  public async destroy(): Promise<void> {
    this.fileWatchers.forEach((watcher) => watcher.close());
    await fsPromises.rm(this.tmpFolder, { force: true, recursive: true });
    this.filePathMap = {};
    this.fileKeyMap = {};
  }

  /**
   * Gets a file from the virtual filesystem and prepares to run a specified
   * action (chainable methods available).
   * @param key Cache key for the file
   * @returns A VfsFile object
   */
  public file(key: string): VfsFile {
    return {
      commit: async () => {
        this.checkInit();

        return new Promise((resolve, reject) => {
          const stream = fs.createReadStream(this.filePathMap[key].path);

          stream.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') {
              this.throwError(
                `Local file "${this.filePathMap[key].path}" not found`
              ).catch((err) => reject(err));
            }

            this.throwError(err.message).catch((err) => reject(err));
          });
          stream.on('ready', async () => {
            await this.s3.send(
              new PutObjectCommand({
                Bucket: this.bucket,
                Key: this.fileKeyMap[key],
                Body: stream,
                ContentType: this.filePathMap[key].mimeType,
              })
            );
          });
          stream.on('end', () => {
            resolve();
            this.filePathMap[key].modified = false;
          });
        });
      },
      delete: async () => {
        await fsPromises.rm(this.filePathMap[key].path, { force: true });
      },
      getPath: async () => {
        this.checkInit();

        if (!this.fileKeyMap[key]) {
          await this.throwError(`No cache key found for "${key}"`);
        }

        if (!this.filePathMap[key]) {
          const { ext } = path.parse(this.fileKeyMap[key]);
          const fullPath = `${this.tmpFolder}/${randomUUID()}${ext}`;
          let response: GetObjectCommandOutput;
          let sizeInBytes: number;

          try {
            response = await this.s3.send(
              new HeadObjectCommand({
                Bucket: this.bucket,
                Key: this.fileKeyMap[key],
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
                Bucket: this.bucket,
                Key: this.fileKeyMap[key],
              })
            );
          } catch (e: unknown) {
            const err = e as Error;

            if (err.name === 'AccessDenied' || err.name === 'NoSuchKey') {
              await this.throwError(
                `${err.name} while getting s3://${this.bucket}/` +
                  this.fileKeyMap[key]
              );
            }

            throw e;
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
          this.filePathMap[key] = { path: fullPath, mimeType, modified: false };
          this.fileWatchers.push(
            fs.watch(this.filePathMap[key].path, () => {
              this.filePathMap[key].modified = true;
            })
          );
        }

        return this.filePathMap[key].path;
      },
    };
  }

  /**
   * Commits all modified files to S3. EXPERIMENTAL FEATURE, due to fs.watch not
   * being completely reliable.
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
   * @param s3Key S3 key to sync to
   * @param mimeType Optional MIME type of the file
   */
  public createFutureFile(
    newKey: string,
    s3Key: string,
    mimeType?: string
  ): VfsFile {
    this.checkInit();

    const { ext } = path.parse(s3Key);
    const fullPath = `${this.tmpFolder}/${randomUUID()}${ext}`;

    this.fileKeyMap[newKey] = s3Key;
    this.filePathMap[newKey] = { path: fullPath, mimeType, modified: false };

    return this.file(newKey);
  }

  private checkInit() {
    if (!this.bucket) {
      throw new Error('VirtualS3FileSystem not initialized');
    }
  }

  private async throwError(errMsg: string) {
    await this.destroy();
    throw new Error('[VirtualS3FileSystem] ' + errMsg);
  }
}

export default VirtualS3FileSystem;
