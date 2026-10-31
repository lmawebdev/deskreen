export const EXTENDED_DISPLAY_BITRATE_OPTIONS = [
	10, 20, 30, 40, 60, 80, 100,
] as const;

export const EXTENDED_DISPLAY_RESOLUTION_SCALES = [1, 1.5, 2] as const;

export const DEFAULT_EXTENDED_DISPLAY_SETTINGS: ExtendedDisplaySettings = {
	frameRate: 60,
	bitrateMbps: 40,
	resolutionScale: 1,
	priority: 'balanced',
};

export interface ExtendedDisplaySettings {
	frameRate: 30 | 60 | 120;
	bitrateMbps: number;
	resolutionScale: 1 | 1.5 | 2;
	priority: 'quality' | 'balanced' | 'latency';
}
