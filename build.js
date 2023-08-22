/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-var-requires */
require('esbuild')
  .build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node18',
    external: ['@aws-sdk/client-s3'],
    outdir: 'dist',
  })
  .then(() => console.log('⚡ Built! Go forth and publish!'))
  .catch(() => process.exit(1));
