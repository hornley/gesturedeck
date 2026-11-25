import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(projectRoot, 'dist', 'site');

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

async function copy(source, destination = source) {
  const sourcePath = path.join(projectRoot, source);
  const destinationPath = path.join(outputRoot, destination);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, { recursive: true });
}

for (const file of [
  'index.html',
  'workspace.html',
  'mobile-remote.html',
  'analytics.html',
  'home.css',
  'styles.css',
  'mobile-remote.css',
  'analytics.css',
  'favicon.svg',
  'app.js',
  'analytics.js',
  'extension/shared/page-bridge.js',
  'extension/shared/protocol.js',
]) {
  await copy(file);
}

for (const file of [
  'pdf-presentation.js',
  'presentation.js',
  'mobile-remote-client.js',
  'mobile-remote-phone.js',
  'usage-analytics-client.js',
  'site-analytics.js',
]) {
  await copy(`src/${file}`);
}

await copy('node_modules/@vercel/analytics/dist/index.mjs');
await copy('node_modules/pdfjs-dist/build/pdf.mjs');
await copy('node_modules/pdfjs-dist/build/pdf.worker.mjs');
await copy('node_modules/pdfjs-dist/cmaps');
await copy('node_modules/pdfjs-dist/standard_fonts');
