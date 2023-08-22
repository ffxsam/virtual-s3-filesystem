# Virtual S3 File System

Sometimes, processing S3 files can be a hassle. With certain tools (ffmpeg, kid3), streaming them through a Node.js process isn't possible because the utility in question needs to read either the entire file, or large chunks of it.

Saving S3 files to process locally comes with its own headaches. You have to generate a random path (to avoid collisions in `/tmp`), process it, possibly create a new file, then save that back to S3 and ensure your temporary folder is wiped.

That's where VS3FS comes in! 👋

VS3FS makes it super easy to use `/tmp` as a virtual disk cache to store and work with S3 files, then easily commit your changes back to S3.

## Installation

```shell
$ pnpm install virtual-s3-filesystem
```

## Usage

Typically, you'll want to create a file in your project where you instantiate (but not initialize) a VS3FS instance:

```ts
// @/libs/vfs.ts
import VirtualS3Filesystem from 'virtual-s3-filesystem';
import { S3Client } from '@aws-sdk/client-s3';

const s3Client = new S3Client({});

export const vfs = new VirtualS3Filesystem({ s3Client });
```

This way, you'll share the same filesystem across modules. Then, in a Lambda function (for example), you'd use it like so:

```ts
import { vfs } from '@/libs/vfs';

export const main = async event => {
  await vfs.init({
    // Map a cache key to an S3 URL
    fileA: 's3://my-bucket/files/fileA.txt',
    // ...or an object specifying bucket/key
    fileB: {
      bucket: 'my-bucket',
      key: 'files/fileB.txt',
    },
  });

  // Code continues below
};
```

Now it's super easy to manage these files:

```ts
const fileA = vfs.file('fileA');
const fileB = vfs.file('fileB');

spawnSync(
  'some_command',
  [
    '-inputs',
    await fileA.getPath(),
    await fileB.getPath()
  ]
);

spawnSync(
  'another_executable',
  [
    '-source',
    // Returns immediately since it's already internally fetched from S3
    await fileB.getPath(),
  ]
)
```

Creating new files and saving them to S3 is also easy. We'll use `createFutureFile` to specify a file in the cache that will exist at some point in the future.

```ts
const wavFile = vfs.file('wavFile');
const mp3File = vfs.createFutureFile('mp3File', 's3://my-bucket/new.mp3', 'audio/mpeg');

spawnSync(
  'ffmpeg',
  [
    '-i',
    await wavFile.getPath(),
    '-c:a',
    'libmp3lame',
    '-b:a',
    '256k',
    await mp3File.getPath(),
  ]
);

await mp3File.commit();
```

When we use `createFutureFile`, it's creating a mapping to a file in `/tmp` that doesn't exist yet, so it expects you to create it, otherwise the call to `commit` will throw an error.

## API Docs

### Instance Methods

```ts
init(fileKeyMap: FileKeyMap): Promise<void>
```
Initializes the virtual filesystem with a mapping of cache keys to S3 objects.

```ts
destroy(): Promise<void>
```
Destroys the virtual filesystem and deletes all local files.

```ts
file(key: string): VfsFile
```
Gets a file from the virtual filesystem and returns a `VfsFile` object with methods to interact with the file.

```ts
commitChanged(): Promise<void>
```
Commits all modified files to S3 (experimental feature).

```ts
createFutureFile(newKey: string, s3Object: S3Url | S3Location, mimeType?: string): VfsFile
```
Creates a placeholder in the cache for a file that will be created in the future and returns a VfsFile object.

### `VfsFile` Object

The VfsFile object provides the following methods:

`commit(): Promise<void>`: Commits the local file to S3.  
`delete(): Promise<void>`: Deletes the local file.  
`getPath(): Promise<string>`: Gets the local path of the file, downloading from S3 if necessary.
