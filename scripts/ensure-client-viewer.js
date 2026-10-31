#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const indexFile = join(root, 'src', 'client-viewer', 'dist', 'index.html');

// The signaling server serves the remote viewer from src/client-viewer/dist.
// The QR code points at that server, so the bundle must exist in dev too.
// Building it once (instead of on every dev start) keeps startup fast.
if (existsSync(indexFile)) {
	process.exit(0);
}

console.log(
	'[ensure-client-viewer] Building the client viewer bundle for the dev server...',
);

const npmExecPath = process.env.npm_execpath;
const result = npmExecPath
	? spawnSync(process.execPath, [npmExecPath, 'run', 'buildClientViewer'], {
			cwd: root,
			stdio: 'inherit',
			windowsHide: true,
		})
	: spawnSync('npm', ['run', 'buildClientViewer'], {
			cwd: root,
			stdio: 'inherit',
			windowsHide: true,
			shell: process.platform === 'win32',
		});

if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}

process.exit(result.status ?? 1);
