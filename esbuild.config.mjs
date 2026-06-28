import { build } from 'esbuild';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

// Node built-ins + electron always come from the host.
const external = [
  'electron',
  'better-sqlite3',
  ...Object.keys(pkg.dependencies ?? {}),
];

await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external,
  logLevel: 'info',
});
