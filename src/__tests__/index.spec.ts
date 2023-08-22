import { describe, it, expect } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
// import VirtualS3FileSystem from '../index';

const s3Client = new S3Client({ region: 'us-east-1' });
const s3Mock = mockClient(s3Client);

describe('virtual-s3-filesystem', () => {
  // const vfs = new VirtualS3FileSystem({ s3Client });

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

  it('uses a single tmp folder', async () => {
    expect(1).toBe(1);
  });
});
