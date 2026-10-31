export const EXTENDED_DISPLAY_FRAME_RATES = [30, 60, 120] as const;

export const EXTENDED_DISPLAY_BITRATE_OPTIONS = [
	10, 20, 30, 40, 60, 80, 100,
] as const;

export const EXTENDED_DISPLAY_RESOLUTION_SCALES = [1, 1.5, 2] as const;

export const EXTENDED_DISPLAY_PRIORITIES = [
	'quality',
	'balanced',
	'latency',
] as const;

export type ExtendedDisplayFrameRate =
	(typeof EXTENDED_DISPLAY_FRAME_RATES)[number];

export type ExtendedDisplayResolutionScale =
	(typeof EXTENDED_DISPLAY_RESOLUTION_SCALES)[number];

export type ExtendedDisplayPriority =
	(typeof EXTENDED_DISPLAY_PRIORITIES)[number];

export interface ExtendedDisplaySettings {
	frameRate: ExtendedDisplayFrameRate;
	bitrateMbps: number;
	resolutionScale: ExtendedDisplayResolutionScale;
	priority: ExtendedDisplayPriority;
}

export const DEFAULT_EXTENDED_DISPLAY_SETTINGS: ExtendedDisplaySettings = {
	frameRate: 60,
	bitrateMbps: 40,
	resolutionScale: 1,
	priority: 'balanced',
};

export function normalizeExtendedDisplayFrameRate(
	value: unknown,
): ExtendedDisplayFrameRate {
	const numeric = typeof value === 'number' ? value : Number(value);

	if (numeric === 30 || numeric === 60 || numeric === 120) {
		return numeric;
	}

	return DEFAULT_EXTENDED_DISPLAY_SETTINGS.frameRate;
}

export function normalizeExtendedDisplayBitrate(value: unknown): number {
	const numeric = typeof value === 'number' ? value : Number(value);

	if (!Number.isFinite(numeric)) {
		return DEFAULT_EXTENDED_DISPLAY_SETTINGS.bitrateMbps;
	}

	return Math.min(100, Math.max(10, Math.round(numeric)));
}

export function normalizeExtendedDisplayResolutionScale(
	value: unknown,
): ExtendedDisplayResolutionScale {
	const numeric = typeof value === 'number' ? value : Number(value);

	if (numeric === 1.5 || numeric === 2) {
		return numeric;
	}

	return 1;
}

export function normalizeExtendedDisplayPriority(
	value: unknown,
): ExtendedDisplayPriority {
	if (value === 'quality' || value === 'latency') {
		return value;
	}

	return 'balanced';
}
