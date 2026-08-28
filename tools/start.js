// Launches Electron with a clean environment.
//
// Editors that embed Node (VS Code's terminal, for one) export
// ELECTRON_RUN_AS_NODE=1, which makes `electron .` boot as a plain Node process
// and `require('electron')` return a path string instead of the API.
const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code == null ? 0 : code));
