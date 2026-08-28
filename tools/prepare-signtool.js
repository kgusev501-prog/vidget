// Prepares electron-builder's signing toolchain so `npm run dist` works on a
// machine without Developer Mode.
//
// electron-builder downloads winCodeSign and unpacks it with 7-Zip. The archive
// carries macOS symlinks, and creating a symlink on Windows needs a privilege
// that a normal account does not have — so the extraction fails, and with it
// the whole NSIS build. None of those macOS files matter for a Windows build,
// so we unpack the archive ourselves and skip them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = 'winCodeSign-2.6.0';
const URL = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${VERSION}/${VERSION}.7z`;

const cacheDir = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'electron-builder',
  'Cache',
  'winCodeSign'
);
const target = path.join(cacheDir, VERSION);

async function main() {
  if (process.platform !== 'win32') return;

  if (fs.existsSync(path.join(target, 'rcedit-x64.exe'))) {
    console.log('[prepare] signing tools already in place');
    return;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, `${VERSION}.7z`);

  if (!fs.existsSync(archive)) {
    console.log('[prepare] downloading', VERSION);
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  }

  const sevenZip = require('7zip-bin').path7za;
  console.log('[prepare] unpacking without the macOS symlinks');
  const out = spawnSync(sevenZip, ['x', '-bd', '-y', `-o${target}`, archive, '-xr!darwin'], {
    encoding: 'utf8',
  });
  if (out.status !== 0) {
    throw new Error(`7-Zip failed: ${(out.stderr || out.stdout || '').trim().split('\n').pop()}`);
  }

  fs.rmSync(archive, { force: true });
  console.log('[prepare] ready:', target);
}

main().catch((err) => {
  console.error('[prepare]', err.message);
  process.exit(1);
});
