import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { Device } from '../../common/Device';
import DesktopCapturerSourcesService from '../DesktopCapturerSourcesService';

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

interface ManagedDisplay {
	child: ChildProcess;
	info: VirtualDisplayInfo;
	slot: number;
	stopping: boolean;
}

interface ReadyPayload {
	event?: string;
	displayID?: number;
	name?: string;
	width?: number;
	height?: number;
	x?: number;
	y?: number;
	boundsWidth?: number;
	boundsHeight?: number;
}

const MAX_VIRTUAL_DISPLAYS = 3;
const HELPER_START_TIMEOUT_MS = 15000;
const SOURCE_RETRY_ATTEMPTS = 20;
const SOURCE_RETRY_DELAY_MS = 250;

export class VirtualDisplayNotSupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'VirtualDisplayNotSupportedError';
	}
}

/**
 * Manages macOS virtual displays, one helper process per connected viewer.
 * Killing the helper removes the display from the system.
 */
export default class VirtualDisplayService {
	private readonly displays = new Map<string, ManagedDisplay>();

	private readonly usedSlots = new Set<number>();

	private readonly resizing = new Set<string>();

	private resizeListener: ((info: VirtualDisplayInfo) => void) | null = null;

	private nextSerial = 1;

	private helperPathCache: string | null | undefined;

	constructor(
		private readonly desktopCapturerSourcesService: DesktopCapturerSourcesService,
	) {}

	isSupported(): boolean {
		return process.platform === 'darwin' && this.getHelperPath() !== '';
	}

	getForDevice(deviceID: string): VirtualDisplayInfo | undefined {
		return this.displays.get(deviceID)?.info;
	}

	setResizeListener(
		listener: ((info: VirtualDisplayInfo) => void) | null,
	): void {
		this.resizeListener = listener;
	}

	private roundToMultipleOf8(value: number, minimum: number): number {
		const rounded = Math.floor(value / 8) * 8;
		return Math.max(rounded, minimum);
	}

	private getHelperPath(): string {
		if (this.helperPathCache !== undefined) {
			return this.helperPathCache ?? '';
		}

		const candidates: string[] = [];
		if (process.resourcesPath) {
			candidates.push(
				join(process.resourcesPath, 'native/DeskreenVirtualDisplay'),
				join(
					process.resourcesPath,
					'app.asar.unpacked/native/DeskreenVirtualDisplay',
				),
			);
		}
		candidates.push(
			join(__dirname, '..', 'native/DeskreenVirtualDisplay'),
			join(process.cwd(), 'out/native/DeskreenVirtualDisplay'),
			join(app.getAppPath(), 'out/native/DeskreenVirtualDisplay'),
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

		// The WindowServer rejects very short virtual-display modes and silently
		// falls back to 800x600, which produces pillarboxing on landscape
		// viewers. Preserve the aspect ratio while keeping the height >= 480.
		const MIN_HEIGHT = 480;
		if (h < MIN_HEIGHT) {
			const scale = MIN_HEIGHT / h;
			w = Math.round(w * scale);
			h = MIN_HEIGHT;
		}

		w = Math.min(w, 4096);
		w = this.roundToMultipleOf8(w, 320);
		h = this.roundToMultipleOf8(h, 240);

		return { width: w, height: h };
	}

	private getDisplaySize(device: Device): { width: number; height: number } {
		return this.normalizeDisplaySize(
			device.deviceScreenWidth,
			device.deviceScreenHeight,
		);
	}

	async createForDevice(device: Device): Promise<VirtualDisplayInfo> {
		if (!this.isSupported()) {
			throw new VirtualDisplayNotSupportedError(
				'La pantalla extendida solo está disponible en macOS con el helper nativo compilado.',
			);
		}

		const existing = this.displays.get(device.id);
		if (existing) {
			return existing.info;
		}

		const slot = this.takeSlot();
		const { width, height } = this.getDisplaySize(device);

		try {
			return await this.createDisplayForDevice({
				deviceID: device.id,
				sharingSessionID: device.sharingSessionID,
				width,
				height,
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
		slot: number;
	}): Promise<VirtualDisplayInfo> {
		const name = `Deskreen Display ${params.slot}`;
		const serial = this.nextSerial;
		this.nextSerial += 1;

		let child: ChildProcess | null = null;

		try {
			const started = await this.spawnHelper({
				width: params.width,
				height: params.height,
				name,
				serial,
			});
			child = started.child;

			const sourceID = await this.resolveSourceID(started.ready.displayID);
			if (!sourceID) {
				throw new Error(
					`El display virtual ${started.ready.displayID} no aparece en desktopCapturer`,
				);
			}

			const info: VirtualDisplayInfo = {
				deviceID: params.deviceID,
				sharingSessionID: params.sharingSessionID,
				displayID: started.ready.displayID,
				sourceID,
				name: started.ready.name ?? name,
				width: started.ready.boundsWidth ?? params.width,
				height: started.ready.boundsHeight ?? params.height,
				x: started.ready.x ?? 0,
				y: started.ready.y ?? 0,
			};

			this.displays.set(params.deviceID, {
				child,
				info,
				slot: params.slot,
				stopping: false,
			});

			return info;
		} catch (error) {
			if (child) {
				try {
					child.kill('SIGKILL');
				} catch {
					// already gone
				}
			}
			throw error;
		}
	}

	async resize(
		deviceID: string,
		width: number,
		height: number,
	): Promise<boolean> {
		if (!this.isSupported()) return false;

		const managed = this.displays.get(deviceID);
		if (!managed) return false;

		const { width: roundedWidth, height: roundedHeight } =
			this.normalizeDisplaySize(width, height);

		if (
			roundedWidth === managed.info.width &&
			roundedHeight === managed.info.height
		) {
			return true;
		}

		// A rotated mode cannot be added to an existing CGVirtualDisplay, so
		// the display is recreated: kill this helper and spawn a new one with
		// the new orientation. Process exit removes the old display even if its
		// origin was configured.
		if (this.resizing.has(deviceID)) return false;
		this.resizing.add(deviceID);

		const { slot, info } = managed;
		const oldDisplayID = info.displayID;
		const sharingSessionID = info.sharingSessionID;

		try {
			this.displays.delete(deviceID);
			this.stopChild(managed);
			await this.waitForDisplayGone(oldDisplayID, 4000);

			const newInfo = await this.createDisplayForDevice({
				deviceID,
				sharingSessionID,
				width: roundedWidth,
				height: roundedHeight,
				slot,
			});

			this.resizeListener?.(newInfo);
			return true;
		} catch (error) {
			console.error('failed to resize virtual display', error);
			this.releaseSlot(slot);
			return false;
		} finally {
			this.resizing.delete(deviceID);
		}
	}

	private async waitForDisplayGone(
		displayID: number,
		timeoutMs: number,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await this.desktopCapturerSourcesService.refreshDesktopCapturerSources();
			const present = this.desktopCapturerSourcesService
				.getScreenSources()
				.some((source) => source.display_id === String(displayID));
			if (!present) return;
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
		ready: ReadyPayload & { displayID: number };
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
					'--parent-pid',
					String(process.pid),
				],
				{
					stdio: ['ignore', 'pipe', 'pipe'],
				},
			);

			let stdoutBuffer = '';
			let stderrBuffer = '';
			let settled = false;

			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				child.kill('SIGKILL');
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
				child.kill('SIGKILL');
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

					if (payload.event !== 'ready' || !payload.displayID) continue;
					if (settled) return;
					settled = true;
					clearTimeout(timeout);

					resolve({
						child,
						ready: payload as ReadyPayload & { displayID: number },
					});
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
				.find((screen) => screen.display_id === String(displayID));

			if (source) return source.id;

			await new Promise((resolve) =>
				setTimeout(resolve, SOURCE_RETRY_DELAY_MS),
			);
		}
		return '';
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
