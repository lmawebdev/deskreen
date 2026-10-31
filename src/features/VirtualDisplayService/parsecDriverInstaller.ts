import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app } from 'electron';

export const PARSEC_DRIVER_VERSION = '0.45.0.0';
export const PARSEC_DRIVER_INSTALLER_NAME = `parsec-vdd-${PARSEC_DRIVER_VERSION}.exe`;

// Official Parsec build server. The same binary is linked from the
// nomi-san/parsec-vdd README as the recommended 0.45 driver.
const PARSEC_DRIVER_DOWNLOAD_URL = `https://builds.parsec.app/vdd/${PARSEC_DRIVER_INSTALLER_NAME}`;
const PARSEC_DRIVER_SHA256 =
	'e23332448fdaf5aa017cb308db5ef6855fac526a7ded05d80c039404126d5362';

const DOWNLOAD_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 180_000;

export type ParsecDriverInstallFailure =
	| 'unsupported-platform'
	| 'helper-missing'
	| 'download-failed'
	| 'hash-mismatch'
	| 'cancelled'
	| 'install-failed'
	| 'timeout'
	| 'driver-not-detected';

type EnsureInstallerResult =
	| { path: string }
	| { error: ParsecDriverInstallFailure; message?: string };

function bundledInstallerCandidates(): string[] {
	const candidates: string[] = [];

	if (process.resourcesPath) {
		candidates.push(
			join(process.resourcesPath, 'drivers', PARSEC_DRIVER_INSTALLER_NAME),
		);
	}

	try {
		candidates.push(
			join(
				app.getAppPath(),
				'resources',
				'drivers',
				PARSEC_DRIVER_INSTALLER_NAME,
			),
		);
	} catch {
		// app.getAppPath() is unavailable before the app is ready.
	}

	candidates.push(
		join(process.cwd(), 'resources', 'drivers', PARSEC_DRIVER_INSTALLER_NAME),
	);

	return candidates;
}

function getCachedInstallerPath(): string {
	return join(app.getPath('userData'), 'drivers', PARSEC_DRIVER_INSTALLER_NAME);
}

export function findBundledParsecDriverInstaller(): string | null {
	for (const candidate of bundledInstallerCandidates()) {
		if (candidate && existsSync(candidate)) {
			return candidate;
		}
	}

	return null;
}

async function downloadInstaller(
	destination: string,
): Promise<EnsureInstallerResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

	try {
		const response = await fetch(PARSEC_DRIVER_DOWNLOAD_URL, {
			redirect: 'follow',
			signal: controller.signal,
		});

		if (!response.ok) {
			return {
				error: 'download-failed',
				message: `HTTP ${response.status} ${response.statusText}`,
			};
		}

		const data = Buffer.from(await response.arrayBuffer());
		const digest = createHash('sha256').update(data).digest('hex');

		if (digest.toLowerCase() !== PARSEC_DRIVER_SHA256) {
			return {
				error: 'hash-mismatch',
				message: 'The downloaded driver does not match the expected checksum.',
			};
		}

		await mkdir(dirname(destination), { recursive: true });
		const temporary = `${destination}.download`;
		await writeFile(temporary, data);
		await rename(temporary, destination);

		return { path: destination };
	} catch (error) {
		return {
			error: 'download-failed',
			message: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timer);
	}
}

async function isValidInstaller(path: string): Promise<boolean> {
	try {
		const data = await readFile(path);
		const digest = createHash('sha256').update(data).digest('hex');
		return digest.toLowerCase() === PARSEC_DRIVER_SHA256;
	} catch {
		return false;
	}
}

/**
 * Returns a local path to the Parsec VDD installer, using a bundled copy when
 * the app ships one and otherwise downloading it from Parsec's official
 * server. The download is cached so it happens at most once per install.
 */
export async function ensureParsecDriverInstaller(): Promise<EnsureInstallerResult> {
	if (process.platform !== 'win32') {
		return { error: 'unsupported-platform' };
	}

	const bundled = findBundledParsecDriverInstaller();
	if (bundled && (await isValidInstaller(bundled))) {
		return { path: bundled };
	}

	const cached = getCachedInstallerPath();
	if (existsSync(cached)) {
		if (await isValidInstaller(cached)) {
			return { path: cached };
		}

		// A corrupt or tampered cache entry is removed before downloading again.
		try {
			await unlink(cached);
		} catch {
			// ignore
		}
	}

	return downloadInstaller(cached);
}

function escapePowerShellString(value: string): string {
	return value.replace(/'/g, "''");
}

/**
 * Runs the driver setup elevated with its silent flag. Windows requires
 * administrator rights to install a kernel display driver, so the user gets
 * a UAC prompt. Resolves with the installer exit code (null on timeout or
 * spawn failure).
 */
export function runParsecDriverInstaller(
	installerPath: string,
): Promise<{ code: number | null; stderr: string; timedOut: boolean }> {
	const script = `
$ErrorActionPreference = 'Stop'
try {
  $process = Start-Process -FilePath '${escapePowerShellString(installerPath)}' -ArgumentList '/S' -Verb RunAs -Wait -PassThru
  exit $process.ExitCode
} catch {
  $exception = $_.Exception
  $inner = $exception.InnerException
  $code = $exception.NativeErrorCode
  if (-not $code -and $inner) { $code = $inner.NativeErrorCode }
  if ($code -eq 1223 -or $exception.HResult -eq -2147023673 -or ($inner -and $inner.HResult -eq -2147023673)) { exit 1223 }
  [Console]::Error.WriteLine($exception.Message)
  exit 1
}
`.trim();

	return new Promise((resolve) => {
		const child = spawn(
			'powershell.exe',
			[
				'-NoProfile',
				'-NonInteractive',
				'-ExecutionPolicy',
				'Bypass',
				'-Command',
				script,
			],
			{ windowsHide: true },
		);

		let stderr = '';
		let settled = false;

		const finish = (
			code: number | null,
			timedOut: boolean,
			message?: string,
		): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				code,
				stderr: message ? `${stderr}\n${message}`.trim() : stderr,
				timedOut,
			});
		};

		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				// already gone
			}
			finish(null, true);
		}, INSTALL_TIMEOUT_MS);

		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => {
			stderr += chunk;
			if (stderr.length > 8000) {
				stderr = stderr.slice(-8000);
			}
		});

		child.on('error', (error) => {
			finish(null, false, error.message);
		});

		child.on('exit', (code) => {
			finish(code, false);
		});
	});
}

export function classifyInstallerFailure(result: {
	code: number | null;
	stderr: string;
	timedOut: boolean;
}): ParsecDriverInstallFailure {
	if (result.timedOut) return 'timeout';

	// 1223 is ERROR_CANCELLED: the user dismissed the UAC prompt.
	if (
		result.code === 1223 ||
		/cancel(?:l)?ed by the user|operation was canceled|1223/i.test(
			result.stderr,
		)
	) {
		return 'cancelled';
	}

	return 'install-failed';
}
