import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The GestureDeck app build requires an Apple Silicon Mac.');
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (capture) {
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
    return result.stdout.trim();
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
  return result.stdout.trim();
}

async function checkLifecycle() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'gesturedeck-lifecycle-'));
  const executable = path.join(temporaryRoot, 'lifecycle-tests');
  try {
    run('xcrun', [
      'swiftc', '-parse-as-library', '-target', 'arm64-apple-macos13.0',
      'macos/Sources/ServerLifecycle.swift',
      'macos/Tests/ServerLifecycleTests.swift',
      '-o', executable,
    ]);
    run(executable, []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function assertArm64(binaryPath) {
  const architectures = run('xcrun', ['lipo', '-archs', binaryPath], { capture: true }).split(/\s+/);
  if (!architectures.includes('arm64')) throw new Error(`${binaryPath} does not contain an ARM64 architecture.`);
  return architectures.join(' ');
}

const appPath = path.join(projectRoot, 'dist', 'macos', 'GestureDeck.app');
const contentsPath = path.join(appPath, 'Contents');
const resourcesPath = path.join(contentsPath, 'Resources');
const serverRoot = path.join(resourcesPath, 'GestureDeck');
const nodePath = path.join(resourcesPath, 'node');
const appExecutable = path.join(contentsPath, 'MacOS', 'GestureDeck');

await checkLifecycle();
await rm(appPath, { recursive: true, force: true });
await mkdir(path.join(serverRoot, 'node_modules', 'pdfjs-dist'), { recursive: true });
await mkdir(path.dirname(nodePath), { recursive: true });

for (const file of [
  'server.mjs',
  'index.html',
  'workspace.html',
  'mobile-remote.html',
  'app.js',
  'styles.css',
  'home.css',
  'mobile-remote.css',
  'favicon.svg',
]) {
  await cp(path.join(projectRoot, file), path.join(serverRoot, file));
}

for (const directory of ['src', 'extension/shared']) {
  await cp(path.join(projectRoot, directory), path.join(serverRoot, directory), { recursive: true });
}

await writeFile(path.join(serverRoot, 'package.json'), '{"type":"module"}\n');
for (const asset of [
  'build/pdf.mjs',
  'build/pdf.worker.mjs',
  'cmaps',
  'standard_fonts',
]) {
  await cp(
    path.join(projectRoot, 'node_modules', 'pdfjs-dist', asset),
    path.join(serverRoot, 'node_modules', 'pdfjs-dist', asset),
    { recursive: true },
  );
}
await cp(
  path.join(projectRoot, 'node_modules', 'pdfjs-dist', 'LICENSE'),
  path.join(serverRoot, 'node_modules', 'pdfjs-dist', 'LICENSE'),
);

await cp(process.execPath, nodePath);
await chmod(nodePath, 0o755);
await cp(path.resolve(path.dirname(process.execPath), '..', 'LICENSE'), path.join(resourcesPath, 'Node-LICENSE'));
await cp(path.join(projectRoot, 'macos', 'Info.plist'), path.join(contentsPath, 'Info.plist'));
await mkdir(path.dirname(appExecutable), { recursive: true });
run('xcrun', [
  'swiftc', '-parse-as-library', '-target', 'arm64-apple-macos13.0', '-O',
  '-framework', 'SwiftUI',
  '-framework', 'AppKit',
  '-framework', 'WebKit',
  '-framework', 'UniformTypeIdentifiers',
  '-o', appExecutable,
  'macos/Sources/GestureDeckApp.swift',
  'macos/Sources/ServerLifecycle.swift',
]);

for (const relativePath of [
  'server.mjs',
  'index.html',
  'workspace.html',
  'mobile-remote.html',
  'app.js',
  'styles.css',
  'home.css',
  'mobile-remote.css',
  'src/mobile-remote-server.js',
  'src/mobile-remote-session.js',
  'src/cloud-remote-server.js',
  'src/websocket.js',
  'src/qr-code.js',
  'extension/shared/page-bridge.js',
  'extension/shared/protocol.js',
  'node_modules/pdfjs-dist/build/pdf.mjs',
  'node_modules/pdfjs-dist/build/pdf.worker.mjs',
  'node_modules/pdfjs-dist/LICENSE',
]) {
  await access(path.join(serverRoot, relativePath));
}

for (const relativePath of ['node_modules/pdfjs-dist/cmaps', 'node_modules/pdfjs-dist/standard_fonts']) {
  if (!(await stat(path.join(serverRoot, relativePath))).isDirectory()) {
    throw new Error(`Missing packaged PDF.js directory: ${relativePath}`);
  }
}

await access(appExecutable, constants.X_OK);
await access(nodePath, constants.X_OK);
const nodeArchitecture = assertArm64(nodePath);
assertArm64(appExecutable);
console.log(`Built ${appPath} (Node: ${nodeArchitecture})`);
