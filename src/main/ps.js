'use strict';

const path = require('path');
const { spawn } = require('child_process');

// Windows PowerShell 5.1 specifically: it still carries the WinRT projection
// and the STA clipboard APIs that PowerShell 7 dropped.
const PS = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

/** Scripts live outside the asar archive, which PowerShell cannot read into. */
function scriptPath(name) {
  return path
    .join(__dirname, '..', 'ps', name)
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

/**
 * Runs a one-shot helper script and returns the JSON object it printed,
 * or null if anything at all went wrong.
 */
function runPs(name, args = [], { timeout = 8000, sta = false } = {}) {
  return new Promise((resolve) => {
    const flags = ['-NoProfile', '-NonInteractive'];
    if (sta) flags.push('-STA');
    flags.push('-ExecutionPolicy', 'Bypass', '-File', scriptPath(name), ...args);

    let child;
    try {
      child = spawn(PS, flags, { windowsHide: true });
    } catch {
      return resolve(null);
    }

    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(null);
    }, timeout);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n').pop();
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve(null);
      }
    });
  });
}

/** Starts a long-lived helper script and hands back the child process. */
function spawnPs(name, args = [], { sta = false } = {}) {
  const flags = ['-NoProfile', '-NonInteractive'];
  if (sta) flags.push('-STA');
  flags.push('-ExecutionPolicy', 'Bypass', '-File', scriptPath(name), ...args);
  return spawn(PS, flags, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

module.exports = { runPs, spawnPs, scriptPath, PS };
