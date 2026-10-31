#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outDir = join(root, 'out', 'native');

// electron-builder copies out/native as extraResources on every platform, so
// the directory must exist even when there is no helper to build.
mkdirSync(outDir, { recursive: true });

const platformArg = process.argv.find((arg) => arg.startsWith('--platform='));
const platform = platformArg
	? platformArg.slice('--platform='.length)
	: process.platform;

function run(command, args) {
	const result = spawnSync(command, args, {
		cwd: root,
		stdio: 'inherit',
		windowsHide: true,
	});

	if (result.error) {
		console.error(result.error.message);
		process.exit(1);
	}

	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

if (platform === 'darwin') {
	run('bash', [join(root, 'scripts', 'build-native-macos.sh')]);
} else if (platform === 'win32') {
	const powershell = spawnSync(
		'pwsh',
		['-NoProfile', '-Command', '$PSVersionTable.PSVersion'],
		{
			stdio: 'ignore',
			windowsHide: true,
		},
	);

	const shell = powershell.status === 0 ? 'pwsh' : 'powershell';

	run(shell, [
		'-NoProfile',
		'-ExecutionPolicy',
		'Bypass',
		'-File',
		join(root, 'scripts', 'build-native-windows.ps1'),
	]);
} else {
	console.log(`Skipping native helpers (unsupported platform: ${platform})`);
}
