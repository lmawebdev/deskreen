import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, Display, screen } from 'electron';
import { Device } from '../../common/Device';
import { getExtendedDisplaySettings } from '../../main/helpers/extendedDisplaySettings';
import DesktopCapturerSourcesService from '../DesktopCapturerSourcesService';
import {
	classifyInstallerFailure,
	ensureParsecDriverInstaller,
	type ParsecDriverInstallFailure,
	runParsecDriverInstaller,
} from './parsecDriverInstaller';

export interface VirtualDisplayInfo {
	deviceID: string;
	sharingSessionID: string;
	displayID: number;
	sourceID: string;
	name: string;
	width: number;
	height: number;
	x: number;
	y: number;
}

export type VirtualDisplaySupportReason =
	| 'helper-missing'
	| 'driver-missing'
	| 'driver-error'
	| 'unsupported-platform';

export interface VirtualDisplaySupportInfo {
	supported: boolean;
	platform: NodeJS.Platform;
	reason?: VirtualDisplaySupportReason;
}

export interface VirtualDisplayDriverInstallResult {
	ok: boolean;
	supported: boolean;
	reason?: ParsecDriverInstallFailure;
	message?: string;
}

interface ManagedDisplay {
	child: ChildProcess;
	info: VirtualDisplayInfo;
	slot: number;
	stopping: boolean;
	/** Normalized size requested by the viewer, in CSS pixels. */
	requestedWidth: number;
	requestedHeight: number;
	/** Raw size reported by the viewer, before resolution scaling. */
	sourceWidth: number;
	sourceHeight: number;
}

interface ReadyPayload {
	event?: string;
	displayID?: number;
	deviceName?: string;
	name?: string;
	width?: number;
	height?: number;
	x?: number;
	y?: number;
	boundsWidth?: number;
	boundsHeight?: number;
	message?: string;
}

const MAX_VIRTUAL_DISPLAYS = 3;
const HELPER_START_TIMEOUT_MS = 15000;
const SOURCE_RETRY_ATTEMPTS = 20;
const SOURCE_RETRY_DELAY_MS = 250;
const WINDOWS_DISPLAY_TIMEOUT_MS = 15000;
const WINDOWS_DISPLAY_FALLBACK_MS = 4000;
const WINDOWS_DISPLAY_RETRY_MS = 100;
const WINDOWS_RESIZE_TIMEOUT_MS = 8000;
const DRIVER_INSTALL_DETECT_TIMEOUT_MS = 30000;
const DRIVER_INSTALL_POLL_MS = 1000;

export class VirtualDisplayNotSupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'VirtualDisplayNotSupportedError';
	}
}

/**
 * Manages virtual displays, one helper process per connected viewer.
 *
 * - macOS: a native helper creates a CGVirtualDisplay and killing it removes
 *   the display from the system.
 * - Windows: a native helper talks to the Parsec Virtual Display Driver
 *   (IddCx). The driver removes the monitor when its keep-alive pings stop.
 */
export default class VirtualDisplayService {
	private readonly displays = new Map<string, ManagedDisplay>();

	private readonly usedSlots = new Set<number>();

	private readonly resizing = new Set<string>();

	private resizeListener: ((info: VirtualDisplayInfo) => void) | null = null;

	private nextSerial = 1;

	private helperPathCache: string | null | undefined;

	private supportInfoCache: VirtualDisplaySupportInfo | undefined;

	constructor(
		private readonly desktopCapturerSourcesService: DesktopCapturerSourcesService,
	) {}

	getSupportInfo(): VirtualDisplaySupportInfo {
		if (this.supportInfoCache) return this.supportInfoCache;

		const platform = process.platform;

		if (platform !== 'darwin' && platform !== 'win32') {
			this.supportInfoCache = {
				supported: false,
				platform,
				reason: 'unsupported-platform',
			};
			return this.supportInfoCache;
		}

		const helperPath = this.getHelperPath();
		if (!helperPath) {
			this.supportInfoCache = {
				supported: false,
				platform,
				reason: 'helper-missing',
			};
			return this.supportInfoCache;
		}

		if (platform === 'darwin') {
			this.supportInfoCache = { supported: true, platform };
			return this.supportInfoCache;
		}

		this.supportInfoCache = this.checkWindowsDriver(helperPath);
		return this.supportInfoCache;
	}

	isSupported(): boolean {
		return this.getSupportInfo().supported;
	}

	getForDevice(deviceID: string): VirtualDisplayInfo | undefined {
		return this.displays.get(deviceID)?.info;
	}

	setResizeListener(
		listener: ((info: VirtualDisplayInfo) => void) | null,
	): void {
		this.resizeListener = listener;
	}

	private checkWindowsDriver(helperPath: string): VirtualDisplaySupportInfo {
		const result = spawnSync(helperPath, ['--check'], {
			encoding: 'utf8',
			timeout: 5000,
			windowsHide: true,
		});

		const output = typeof result.stdout === 'string' ? result.stdout : '';
		const lines = output
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		const lastLine = lines.length > 0 ? lines[lines.length - 1] : '';

		if (lastLine) {
			try {
				const payload = JSON.parse(lastLine) as {
					supported?: boolean;
					reason?: string;
				};

				if (payload?.supported === true) {
					return { supported: true, platform: 'win32' };
				}

				return {
					supported: false,
					platform: 'win32',
					reason:
						payload?.reason === 'parsec-vdd-not-installed'
							? 'driver-missing'
							: 'driver-error',
				};
			} catch {
				// Fall through to the generic error below.
			}
		}

		return {
			supported: false,
			platform: 'win32',
			reason: result.error ? 'driver-error' : 'driver-missing',
		};
	}

	/**
	 * Installs the Parsec Virtual Display Driver on demand.
	 *
	 * The app ships the signed Parsec installer when possible and otherwise
	 * downloads it from Parsec's official server, so the user never has to
	 * fetch anything manually. Installing a display driver always requires
	 * administrator rights, which means a single UAC confirmation.
	 */
	async installWindowsDriver(): Promise<VirtualDisplayDriverInstallResult> {
		if (process.platform !== 'win32') {
			return { ok: false, supported: false, reason: 'unsupported-platform' };
		}

		const helperPath = this.getHelperPath();
		if (!helperPath) {
			return { ok: false, supported: false, reason: 'helper-missing' };
		}

		const installer = await ensureParsecDriverInstaller();
		if ('error' in installer) {
			return {
				ok: false,
				supported: false,
				reason: installer.error,
				message: installer.message,
			};
		}

		const result = await runParsecDriverInstaller(installer.path);
		if (result.code !== 0) {
			return {
				ok: false,
				supported: false,
				reason: classifyInstallerFailure(result),
				message: result.stderr.trim() || undefined,
			};
		}

		const supported = await this.waitForWindowsDriver(
			helperPath,
			DRIVER_INSTALL_DETECT_TIMEOUT_MS,
		);

		this.supportInfoCache = supported
			? { supported: true, platform: 'win32' }
			: { supported: false, platform: 'win32', reason: 'driver-missing' };

		if (!supported) {
			return { ok: false, supported: false, reason: 'driver-not-detected' };
		}

		return { ok: true, supported: true };
	}

	private async waitForWindowsDriver(
		helperPath: string,
		timeoutMs: number,
	): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			if (this.checkWindowsDriver(helperPath).supported) {
				return true;
			}

			await new Promise((resolve) =>
				setTimeout(resolve, DRIVER_INSTALL_POLL_MS),
			);
		}

		return false;
	}

	private roundToMultipleOf8(value: number, minimum: number): number {
		const rounded = Math.floor(value / 8) * 8;
		return Math.max(rounded, minimum);
	}

	private getHelperPath(): string {
		if (this.helperPathCache !== undefined) {
			return this.helperPathCache ?? '';
		}

		const helperFile =
			process.platform === 'win32'
				? 'DeskreenVirtualDisplay.exe'
				: 'DeskreenVirtualDisplay';

		const candidates: string[] = [];
		if (process.resourcesPath) {
			candidates.push(
				join(process.resourcesPath, 'native', helperFile),
				join(process.resourcesPath, 'app.asar.unpacked/native', helperFile),
			);
		}
		candidates.push(
			join(__dirname, '..', 'native', helperFile),
			join(process.cwd(), 'out/native', helperFile),
			join(app.getAppPath(), 'out/native', helperFile),
		);

		for (const candidate of candidates) {
			if (candidate && existsSync(candidate)) {
				this.helperPathCache = candidate;
				return candidate;
			}
		}

		this.helperPathCache = null;
		return '';
	}

	private takeSlot(): number {
		for (let slot = 1; slot <= MAX_VIRTUAL_DISPLAYS; slot += 1) {
			if (!this.usedSlots.has(slot)) {
				this.usedSlots.add(slot);
				return slot;
			}
		}
		throw new VirtualDisplayNotSupportedError(
			`No hay más slots de pantalla virtual (máximo ${MAX_VIRTUAL_DISPLAYS})`,
		);
	}

	private releaseSlot(slot: number): void {
		this.usedSlots.delete(slot);
	}

	private normalizeDisplaySize(
		width: number,
		height: number,
	): { width: number; height: number } {
		let w = Number.isFinite(width) && width > 0 ? Math.round(width) : 0;
		let h = Number.isFinite(height) && height > 0 ? Math.round(height) : 0;

		if (w < 320 || h < 240) {
			w = 1280;
			h = 800;
		}

		// Guard against absurd values from a misbehaving client.
		w = Math.min(Math.max(w, 320), 4096);
		h = Math.min(Math.max(h, 240), 4096);

		// Some display servers reject very short modes and silently fall back
		// to a landscape default, which produces pillarboxing on portrait
		// viewers. Preserve the aspect ratio while keeping the height >= 480.
		const MIN_HEIGHT = 480;
		if (h < MIN_HEIGHT) {
			const scale = MIN_HEIGHT / h;
			w = Math.round(w * scale);
			h = MIN_HEIGHT;
		}

		// Use a physical resolution large enough to stay sharp on high-DPI
		// viewers. A small CSS viewport (e.g. 360x800) would otherwise create
		// a low-resolution virtual monitor.
		const MIN_WIDTH = 1280;
		if (w < MIN_WIDTH) {
			const scale = MIN_WIDTH / w;
			w = Math.round(w * scale);
			h = Math.round(h * scale);
		}

		const { resolutionScale } = getExtendedDisplaySettings();
		if (resolutionScale !== 1) {
			w = Math.round(w * resolutionScale);
			h = Math.round(h * resolutionScale);
		}

		w = Math.min(w, 4096);
		h = Math.min(h, 4096);
		w = this.roundToMultipleOf8(w, 320);
		h = this.roundToMultipleOf8(h, 240);

		return { width: w, height: h };
	}

	private getPreferredFrameRate(): number {
		return getExtendedDisplaySettings().frameRate;
	}

	async createForDevice(device: Device): Promise<VirtualDisplayInfo> {
		if (!this.isSupported()) {
			const support = this.getSupportInfo();
			let message =
				'La pantalla extendida no está disponible en esta plataforma.';

			if (support.reason === 'driver-missing') {
				message =
					'La pantalla extendida en Windows requiere el Parsec Virtual Display Driver instalado.';
			} else if (support.reason === 'helper-missing') {
				message = 'No se encontró el helper nativo DeskreenVirtualDisplay.';
			}

			throw new VirtualDisplayNotSupportedError(message);
		}

		const existing = this.displays.get(device.id);
		if (existing) {
			return existing.info;
		}

		const slot = this.takeSlot();
		const sourceWidth = device.deviceScreenWidth;
		const sourceHeight = device.deviceScreenHeight;
		const { width, height } = this.normalizeDisplaySize(
			sourceWidth,
			sourceHeight,
		);

		try {
			return await this.createDisplayForDevice({
				deviceID: device.id,
				sharingSessionID: device.sharingSessionID,
				width,
				height,
				sourceWidth,
				sourceHeight,
				slot,
			});
		} catch (error) {
			this.releaseSlot(slot);
			throw error;
		}
	}

	private async createDisplayForDevice(params: {
		deviceID: string;
		sharingSessionID: string;
		width: number;
		height: number;
		sourceWidth: number;
		sourceHeight: number;
		slot: number;
	}): Promise<VirtualDisplayInfo> {
		const name = `Deskreen Display ${params.slot}`;
		const serial = this.nextSerial;
		this.nextSerial += 1;

		const isWindows = process.platform === 'win32';
		const previousDisplayIDs = isWindows
			? new Set(this.getScreenDisplays().map((display) => display.id))
			: null;

		let child: ChildProcess | null = null;

		try {
			const started = await this.spawnHelper({
				width: params.width,
				height: params.height,
				name,
				serial,
			});
			child = started.child;

			let displayID: number;
			let detectedDisplay: Display | undefined;

			if (isWindows) {
				detectedDisplay = await this.waitForWindowsDisplay(
					previousDisplayIDs ?? new Set<number>(),
					started.ready,
				);
				displayID = detectedDisplay.id;
			} else {
				if (!started.ready.displayID) {
					throw new Error(
						'El helper de pantalla virtual no devolvió un displayID',
					);
				}
				displayID = started.ready.displayID;
			}

			const sourceID = await this.resolveSourceID(displayID);
			if (!sourceID) {
				throw new Error(
					`El display virtual ${displayID} no aparece en desktopCapturer`,
				);
			}

			const info: VirtualDisplayInfo = {
				deviceID: params.deviceID,
				sharingSessionID: params.sharingSessionID,
				displayID,
				sourceID,
				name: started.ready.name ?? name,
				width:
					started.ready.boundsWidth ??
					detectedDisplay?.size.width ??
					params.width,
				height:
					started.ready.boundsHeight ??
					detectedDisplay?.size.height ??
					params.height,
				x: detectedDisplay?.bounds.x ?? started.ready.x ?? 0,
				y: detectedDisplay?.bounds.y ?? started.ready.y ?? 0,
			};

			this.displays.set(params.deviceID, {
				child,
				info,
				slot: params.slot,
				stopping: false,
				requestedWidth: params.width,
				requestedHeight: params.height,
				sourceWidth: params.sourceWidth,
				sourceHeight: params.sourceHeight,
			});

			return info;
		} catch (error) {
			if (child) {
				try {
					child.kill();
				} catch {
					// already gone
				}
			}
			throw error;
		}
	}

	private getScreenDisplays(): Display[] {
		try {
			return screen.getAllDisplays();
		} catch (error) {
			console.error('failed to read the list of displays', error);
			return [];
		}
	}

	private displayMatchesReady(display: Display, ready: ReadyPayload): boolean {
		const expectedWidth = ready.boundsWidth ?? ready.width ?? 0;
		const expectedHeight = ready.boundsHeight ?? ready.height ?? 0;

		if (expectedWidth <= 0 || expectedHeight <= 0) return true;

		if (
			display.size.width === expectedWidth &&
			display.size.height === expectedHeight
		) {
			return true;
		}

		const expectedAspect = expectedWidth / expectedHeight;
		const actualAspect = display.size.width / display.size.height;
		return Math.abs(expectedAspect - actualAspect) < 0.02;
	}

	private pickBestDisplay(displays: Display[], ready: ReadyPayload): Display {
		const expectedWidth = ready.boundsWidth ?? ready.width ?? 0;
		const expectedHeight = ready.boundsHeight ?? ready.height ?? 0;

		const exact = displays.find(
			(display) =>
				display.size.width === expectedWidth &&
				display.size.height === expectedHeight,
		);
		if (exact) return exact;

		const byAspect = displays.filter((display) =>
			this.displayMatchesReady(display, ready),
		);
		const pool = byAspect.length > 0 ? byAspect : displays;

		// The helper places the new monitor to the right of every other
		// display, so the rightmost match is the safest fallback when the
		// driver reuses an existing Electron display id.
		return [...pool].sort((a, b) => b.bounds.x - a.bounds.x)[0];
	}

	private async waitForWindowsDisplay(
		previousDisplayIDs: Set<number>,
		ready: ReadyPayload,
	): Promise<Display> {
		const startedAt = Date.now();
		const deadline = startedAt + WINDOWS_DISPLAY_TIMEOUT_MS;
		const fallbackAt = startedAt + WINDOWS_DISPLAY_FALLBACK_MS;

		while (Date.now() < deadline) {
			const displays = this.getScreenDisplays();
			const freshDisplays = displays.filter(
				(display) => !previousDisplayIDs.has(display.id),
			);

			if (freshDisplays.length > 0) {
				return this.pickBestDisplay(freshDisplays, ready);
			}

			// If the driver reused a monitor id, there is no "fresh" display
			// to diff. After a short grace period accept a display that
			// matches the requested size or aspect ratio.
			if (Date.now() >= fallbackAt) {
				const matchingDisplays = displays.filter((display) =>
					this.displayMatchesReady(display, ready),
				);
				if (matchingDisplays.length > 0) {
					return this.pickBestDisplay(matchingDisplays, ready);
				}
			}

			await new Promise((resolve) =>
				setTimeout(resolve, WINDOWS_DISPLAY_RETRY_MS),
			);
		}

		throw new Error(
			'Windows no reportó el display virtual creado por el helper',
		);
	}

	async resize(
		deviceID: string,
		width: number,
		height: number,
		force = false,
	): Promise<boolean> {
		if (!this.isSupported()) return false;

		const managed = this.displays.get(deviceID);
		if (!managed) return false;

		const { width: roundedWidth, height: roundedHeight } =
			this.normalizeDisplaySize(width, height);

		if (
			!force &&
			roundedWidth === managed.requestedWidth &&
			roundedHeight === managed.requestedHeight
		) {
			return true;
		}

		if (this.resizing.has(deviceID)) return false;
		this.resizing.add(deviceID);

		try {
			if (process.platform === 'win32') {
				try {
					const resized = await this.resizeWindowsDisplay(
						managed,
						roundedWidth,
						roundedHeight,
					);

					if (resized) {
						managed.requestedWidth = roundedWidth;
						managed.requestedHeight = roundedHeight;
						managed.sourceWidth = width;
						managed.sourceHeight = height;
					}

					return resized;
				} catch (error) {
					console.error('failed to resize virtual display', error);
					return false;
				}
			}

			try {
				// macOS: a rotated mode cannot be added to an existing
				// CGVirtualDisplay, so the display is recreated: kill this
				// helper and spawn a new one with the new orientation. Process
				// exit removes the old display even if its origin was
				// configured.
				const { slot, info } = managed;
				const oldDisplayID = info.displayID;
				const sharingSessionID = info.sharingSessionID;

				this.displays.delete(deviceID);
				this.stopChild(managed);
				await this.waitForDisplayGone(oldDisplayID, 4000);

				const newInfo = await this.createDisplayForDevice({
					deviceID,
					sharingSessionID,
					width: roundedWidth,
					height: roundedHeight,
					sourceWidth: managed.sourceWidth,
					sourceHeight: managed.sourceHeight,
					slot,
				});

				this.resizeListener?.(newInfo);
				return true;
			} catch (error) {
				console.error('failed to resize virtual display', error);
				this.releaseSlot(managed.slot);
				return false;
			}
		} finally {
			this.resizing.delete(deviceID);
		}
	}

	private async resizeWindowsDisplay(
		managed: ManagedDisplay,
		width: number,
		height: number,
	): Promise<boolean> {
		const { child } = managed;
		if (!child.stdin || !child.stdin.writable || !child.stdout) return false;

		const payload = await new Promise<ReadyPayload | null>((resolve) => {
			let buffer = '';
			let settled = false;
			let timer: NodeJS.Timeout | undefined;

			const finish = (value: ReadyPayload | null): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				child.stdout?.off('data', onData);
				resolve(value);
			};

			const onData = (chunk: string | Buffer): void => {
				buffer += chunk.toString();
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					let event: ReadyPayload;
					try {
						event = JSON.parse(trimmed) as ReadyPayload;
					} catch {
						continue;
					}

					if (event.event === 'resized') {
						finish(event);
						return;
					}

					if (event.event === 'resize-error') {
						finish(null);
						return;
					}
				}
			};

			timer = setTimeout(() => finish(null), WINDOWS_RESIZE_TIMEOUT_MS);
			child.stdout?.on('data', onData);

			try {
				child.stdin?.write(
					`${JSON.stringify({
						command: 'resize',
						width,
						height,
						refresh: this.getPreferredFrameRate(),
					})}\n`,
				);
			} catch (error) {
				console.error(
					'failed to send resize command to virtual display',
					error,
				);
				finish(null);
			}
		});

		if (!payload) return false;

		const resizedWidth = payload.boundsWidth ?? payload.width;
		const resizedHeight = payload.boundsHeight ?? payload.height;
		if (!resizedWidth || !resizedHeight) return false;

		managed.info = {
			...managed.info,
			width: resizedWidth,
			height: resizedHeight,
			x: payload.x ?? managed.info.x,
			y: payload.y ?? managed.info.y,
		};

		this.resizeListener?.(managed.info);
		return true;
	}

	private async waitForDisplayGone(
		displayID: number,
		timeoutMs: number,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (process.platform === 'win32') {
				const present = this.getScreenDisplays().some(
					(display) => display.id === displayID,
				);
				if (!present) return;
			} else {
				await this.desktopCapturerSourcesService.refreshDesktopCapturerSources();
				const present = this.desktopCapturerSourcesService
					.getScreenSources()
					.some((source) => source.display_id === String(displayID));
				if (!present) return;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	private spawnHelper(args: {
		width: number;
		height: number;
		name: string;
		serial: number;
	}): Promise<{
		child: ChildProcess;
		ready: ReadyPayload;
	}> {
		const helperPath = this.getHelperPath();
		if (!helperPath) {
			throw new VirtualDisplayNotSupportedError(
				'No se encontró el helper nativo DeskreenVirtualDisplay.',
			);
		}

		return new Promise((resolve, reject) => {
			const child = spawn(
				helperPath,
				[
					'--width',
					String(args.width),
					'--height',
					String(args.height),
					'--name',
					args.name,
					'--serial',
					String(args.serial),
					'--refresh',
					String(this.getPreferredFrameRate()),
					'--parent-pid',
					String(process.pid),
				],
				{
					stdio: ['pipe', 'pipe', 'pipe'],
					windowsHide: true,
				},
			);

			let stdoutBuffer = '';
			let stderrBuffer = '';
			let settled = false;

			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				child.kill();
				reject(
					new Error(
						`El helper de pantalla virtual no respondió en ${HELPER_START_TIMEOUT_MS}ms`,
					),
				);
			}, HELPER_START_TIMEOUT_MS);

			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				child.kill();
				reject(error);
			};

			child.stdout?.setEncoding('utf8');
			child.stderr?.setEncoding('utf8');

			child.stderr?.on('data', (chunk: string) => {
				stderrBuffer += chunk;
				if (stderrBuffer.length > 8000) {
					stderrBuffer = stderrBuffer.slice(-8000);
				}
			});

			child.stdout?.on('data', (chunk: string) => {
				stdoutBuffer += chunk;
				const lines = stdoutBuffer.split('\n');
				stdoutBuffer = lines.pop() ?? '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					let payload: ReadyPayload;
					try {
						payload = JSON.parse(trimmed) as ReadyPayload;
					} catch {
						continue;
					}

					if (payload.event !== 'ready') {
						if (
							settled &&
							payload.event &&
							payload.event !== 'resized' &&
							payload.event !== 'resize-error'
						) {
							console.error('[virtual-display]', payload);
						}
						continue;
					}

					if (settled) return;
					settled = true;
					clearTimeout(timeout);

					resolve({ child, ready: payload });
					return;
				}
			});

			child.on('error', (error) => {
				fail(error instanceof Error ? error : new Error(String(error)));
			});

			child.on('exit', (code, signal) => {
				const detail = stderrBuffer.trim();
				if (!settled) {
					fail(
						new Error(
							`El helper de pantalla virtual terminó (code=${code}, signal=${signal}) ${detail}`,
						),
					);
					return;
				}

				// Clean up a display whose helper died unexpectedly.
				for (const [key, managed] of this.displays) {
					if (managed.child === child) {
						this.displays.delete(key);
						this.releaseSlot(managed.slot);
					}
				}
			});
		});
	}

	private async resolveSourceID(displayID: number): Promise<string> {
		for (let attempt = 0; attempt < SOURCE_RETRY_ATTEMPTS; attempt += 1) {
			await this.desktopCapturerSourcesService.refreshDesktopCapturerSources();
			const source = this.desktopCapturerSourcesService
				.getScreenSources()
				.find((screenSource) => screenSource.display_id === String(displayID));

			if (source) return source.id;

			await new Promise((resolve) =>
				setTimeout(resolve, SOURCE_RETRY_DELAY_MS),
			);
		}
		return '';
	}

	applySettingsToDisplays(): void {
		for (const [deviceID, managed] of [...this.displays.entries()]) {
			void this.resize(
				deviceID,
				managed.sourceWidth,
				managed.sourceHeight,
				true,
			);
		}
	}

	destroyForDevice(deviceID: string): void {
		const managed = this.displays.get(deviceID);
		if (!managed) return;
		this.displays.delete(deviceID);
		this.releaseSlot(managed.slot);
		this.stopChild(managed);
	}

	destroyForSession(sharingSessionID: string): void {
		for (const [key, managed] of [...this.displays.entries()]) {
			if (managed.info.sharingSessionID !== sharingSessionID) continue;
			this.displays.delete(key);
			this.releaseSlot(managed.slot);
			this.stopChild(managed);
		}
	}

	destroyAll(): void {
		for (const [key, managed] of [...this.displays.entries()]) {
			this.displays.delete(key);
			this.releaseSlot(managed.slot);
			this.stopChild(managed);
		}
	}

	private stopChild(managed: ManagedDisplay): void {
		if (managed.stopping) return;
		managed.stopping = true;

		if (process.platform === 'win32') {
			// Ask the helper to unplug its monitor before exiting. If it does
			// not answer, terminating it lets the driver watchdog remove the
			// monitor as soon as the keep-alive pings stop.
			try {
				if (managed.child.stdin?.writable) {
					managed.child.stdin.write('shutdown\n');
				}
			} catch {
				// already gone
			}

			setTimeout(() => {
				if (managed.child.exitCode === null) {
					try {
						managed.child.kill();
					} catch {
						// already gone
					}
				}
			}, 1500);
			return;
		}

		try {
			managed.child.kill('SIGTERM');
		} catch (error) {
			console.error('failed to stop virtual display helper', error);
		}
		setTimeout(() => {
			if (managed.child.exitCode === null) {
				try {
					managed.child.kill('SIGKILL');
				} catch {
					// already gone
				}
			}
		}, 2000);
	}
}
