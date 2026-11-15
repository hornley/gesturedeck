import test from 'node:test';
import assert from 'node:assert/strict';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(projectRoot, 'dist');

async function exists(relativePath) {
  try {
    await access(path.join(outputRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

test('Vercel build omits camera assets and retains PDF and remote assets', async (t) => {
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  const build = spawnSync(process.execPath, ['scripts/build-vercel.mjs'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  for (const removed of [
    'assets/hand_landmarker.task',
    'src/camera-session.js',
    'src/camera-preview.js',
    'src/hand-overlay.js',
    'src/hand-tracking.js',
    'src/local-hand-tracker.js',
    'src/gesture-engine.js',
    'node_modules/@mediapipe/tasks-vision/vision_bundle.mjs',
    'node_modules/@mediapipe/tasks-vision/wasm',
  ]) {
    assert.equal(await exists(removed), false, `${removed} should be absent from dist`);
  }

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
    assert.equal(await exists(retained), true, `${retained} should remain in dist`);
  }
});
