import { store } from '../../common/deskreen-electron-store';
import { ElectronStoreKeys } from '../../common/ElectronStoreKeys.enum';
import {
	type ExtendedDisplaySettings,
	normalizeExtendedDisplayBitrate,
	normalizeExtendedDisplayFrameRate,
	normalizeExtendedDisplayPriority,
	normalizeExtendedDisplayResolutionScale,
} from '../../common/ExtendedDisplaySettings';

export function getExtendedDisplaySettings(): ExtendedDisplaySettings {
	return {
		frameRate: normalizeExtendedDisplayFrameRate(
			store.get(ElectronStoreKeys.ExtendedDisplayFrameRate),
		),
		bitrateMbps: normalizeExtendedDisplayBitrate(
			store.get(ElectronStoreKeys.ExtendedDisplayBitrate),
		),
		resolutionScale: normalizeExtendedDisplayResolutionScale(
			store.get(ElectronStoreKeys.ExtendedDisplayResolutionScale),
		),
		priority: normalizeExtendedDisplayPriority(
			store.get(ElectronStoreKeys.ExtendedDisplayPriority),
		),
	};
}

export function saveExtendedDisplaySettings(
	settings: Partial<Record<keyof ExtendedDisplaySettings, unknown>> | undefined,
): ExtendedDisplaySettings {
	const current = getExtendedDisplaySettings();
	const next: ExtendedDisplaySettings = {
		frameRate: normalizeExtendedDisplayFrameRate(
			settings?.frameRate ?? current.frameRate,
		),
		bitrateMbps: normalizeExtendedDisplayBitrate(
			settings?.bitrateMbps ?? current.bitrateMbps,
		),
		resolutionScale: normalizeExtendedDisplayResolutionScale(
			settings?.resolutionScale ?? current.resolutionScale,
		),
		priority: normalizeExtendedDisplayPriority(
			settings?.priority ?? current.priority,
		),
	};

	store.set(
		ElectronStoreKeys.ExtendedDisplayFrameRate,
		String(next.frameRate),
	);
	store.set(
		ElectronStoreKeys.ExtendedDisplayBitrate,
		String(next.bitrateMbps),
	);
	store.set(
		ElectronStoreKeys.ExtendedDisplayResolutionScale,
		String(next.resolutionScale),
	);
	store.set(ElectronStoreKeys.ExtendedDisplayPriority, next.priority);

	return next;
}
