/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, type Mock, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable, Writable } from 'node:stream';
import * as fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import VirtualS3FileSystem from '../index';

// Create mocks for fs and fsPromises
vi.mock('node:fs/promises');
vi.mock('node:fs');

const s3Client = new S3Client({ region: 'us-east-1' });
const s3Mock = mockClient(s3Client);

describe('virtual-s3-filesystem', () => {
  const vfs = new VirtualS3FileSystem({ s3Client });

  beforeEach(() => {
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: 2,
      ContentType: 'text/plain',
    });
    s3Mock.on(GetObjectCommand).resolves({
      // @ts-expect-error This is legit
      Body: Readable.from('hi'),
      ContentLength: 2,
      ContentType: 'text/plain',
    });

    (fs.watch as Mock).mockReturnValue({
      close: () => {},
    });

    (fs.createWriteStream as Mock).mockImplementation(() => {
      return new Writable({
        write(chunk, encoding, callback) {
          callback(); // consume the chunk and continue
        },
      });
    });
  });

  it('initializes properly', async () => {
    (fsPromises.statfs as Mock).mockResolvedValue({
      bavail: 1000000,
      bsize: 1024,
    });
    await vfs.init({
      fileA: 's3://my-bucket/path/to/fileA.txt',
    });

    const vfsPrivate = vfs as any;

    expect(vfsPrivate.fileKeyMap.fileA).toEqual({
      bucket: 'my-bucket',
      key: 'path/to/fileA.txt',
    });
    expect(vfsPrivate.tmpFolder).toMatch(/^\/tmp\/vs3fs-/);
  });

  it('uses a single tmp folder', async () => {
    (fs.createReadStream as Mock).mockReturnValue(Readable.from('hi'));

    await vfs.init({
      fileA: 's3://my-bucket/path/to/fileA.txt',
      fileB: {
        bucket: 'another-bucket',
        key: 'path/to/fileB.txt',
      },
    });

    const fileAPath = await vfs.file('fileA').getPath();
    const fileBPath = await vfs.file('fileB').getPath();

    expect(fileAPath.slice(0, 48)).toBe(fileBPath.slice(0, 48));
  });
});
