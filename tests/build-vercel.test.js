import test from 'node:test';
import assert from 'node:assert/strict';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(projectRoot, 'dist', 'site');

async function exists(relativePath) {
  try {
    await access(path.join(outputRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

test('Vercel build retains required presentation and remote assets', async (t) => {
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  const build = spawnSync(process.execPath, ['scripts/build-vercel.mjs'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  for (const retained of [
    'workspace.html',
    'src/pdf-presentation.js',
    'src/presentation.js',
    'src/mobile-remote-client.js',
    'src/mobile-remote-phone.js',
    'extension/shared/page-bridge.js',
    'extension/shared/protocol.js',
    'node_modules/pdfjs-dist/build/pdf.mjs',
    'node_modules/pdfjs-dist/build/pdf.worker.mjs',
  ]) {
    assert.equal(await exists(retained), true, `${retained} should remain in dist/site`);
  }
});
