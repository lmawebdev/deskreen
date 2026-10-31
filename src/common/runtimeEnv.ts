/**
 * Environment helpers that are safe to call from both the main process (Node)
 * and the renderer. In the browser `process` is not defined, so a direct
 * `process.env` access throws `ReferenceError: process is not defined`.
 */
function readEnv(name: string): string | undefined {
	try {
		if (typeof process === 'undefined' || !process.env) return undefined;
		return process.env[name];
	} catch {
		return undefined;
	}
}

export function isTestMode(): boolean {
	return readEnv('RUN_MODE') === 'test';
}

export function isDevMode(): boolean {
	return (
		readEnv('RUN_MODE') === 'dev' || readEnv('NODE_ENV') === 'development'
	);
}

export function isProductionMode(): boolean {
	const nodeEnv = readEnv('NODE_ENV');
	if (nodeEnv !== undefined) {
		return (
			nodeEnv === 'production' &&
			readEnv('RUN_MODE') !== 'dev' &&
			readEnv('RUN_MODE') !== 'test'
		);
	}

	// Renderer: Vite replaces import.meta.env at build time.
	const viteEnv = (
		import.meta as ImportMeta & {
			env?: { PROD?: boolean; MODE?: string };
		}
	).env;

	return Boolean(viteEnv?.PROD) && viteEnv?.MODE !== 'test';
}
