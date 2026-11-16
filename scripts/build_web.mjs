import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'build/web');
const staticDirectory = resolve(root, 'agent_debug_room/static');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(staticDirectory, output, { recursive: true });
const original = await readFile(resolve(staticDirectory, 'index.html'), 'utf8');
const entry = '<script src="/app.js" type="module"></script>';
if (!original.includes(entry)) throw new Error('The canonical room entry point changed; update the hosted adapter explicitly');
const room = original.replace(entry, '<script src="/room-bootstrap.js" type="module"></script>')
  .replace('</head>', '  <link rel="stylesheet" href="/cloud.css">\n</head>');
await writeFile(resolve(output, 'room.html'), room);
await cp(resolve(root, 'web/README.md'), resolve(output, 'README.md'));
await cp(resolve(root, 'web/index.html'), resolve(output, 'index.html'));
await cp(resolve(root, 'web/style.css'), resolve(output, 'cloud.css'));
for (const filename of await readdir(resolve(staticDirectory, 'locales'))) {
  if (!filename.endsWith('.json')) continue;
  const base = JSON.parse(await readFile(resolve(staticDirectory, 'locales', filename), 'utf8'));
  const cloud = JSON.parse(await readFile(resolve(root, 'web/locales', filename), 'utf8'));
  const duplicate = Object.keys(cloud).filter(key => Object.hasOwn(base, key));
  if (duplicate.length) throw new Error(`Duplicate locale keys in ${filename}: ${duplicate.join(', ')}`);
  await writeFile(resolve(output, 'locales', filename), JSON.stringify({ ...base, ...cloud }, null, 2) + '\n');
}
await build({
  absWorkingDir: root,
  entryPoints: { lobby: 'web/lobby.mjs', 'room-bootstrap': 'web/room-bootstrap.mjs' },
  outdir: output,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'linked',
  external: ['/app.js', '/i18n.mjs'],
});
console.log('Built Firebase Hosting assets in build/web (10 locales).');
