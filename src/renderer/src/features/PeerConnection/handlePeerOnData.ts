import DesktopCapturerSourceType from '../../../../common/DesktopCapturerSourceType';
import { IpcEvents } from '../../../../common/IpcEvents.enum';
import type { HostPartnerConnection } from './index';
import prepareDataMessageToSendScreenSourceType from './prepareDataMessageToSendScreenSourceType';

export default function handlePeerOnData(
	peerConnection: PeerConnection,
	partner: HostPartnerConnection,
	data: string,
): void {
	let dataJSON: {
		type?: string;
		payload?: {
			value?: number;
			frameRate?: number;
			bitrateMbps?: number;
			resolutionScale?: number;
			priority?: string;
		};
	};
	try {
		dataJSON = JSON.parse(data);
	} catch (error) {
		console.error('failed to parse peer data message', error);
		return;
	}

	if (dataJSON.type === 'extended_display_settings') {
		const payload = dataJSON.payload;
		if (!payload) return;

		void window.electron.ipcRenderer.invoke(
			IpcEvents.SetExtendedDisplaySettings,
			{
				frameRate: payload.frameRate,
				bitrateMbps: payload.bitrateMbps,
				resolutionScale: payload.resolutionScale,
				priority: payload.priority,
			},
		);
		return;
	}

	if (dataJSON.type === 'set_video_quality') {
		const requestedQuality = dataJSON.payload?.value;
		if (typeof requestedQuality !== 'number') return;

		if (peerConnection.isExtendedDisplayMode) {
			// Extended displays keep their native track. Replacing it with the
			// auto-quality track can produce odd dimensions (e.g. 206x459) and
			// freeze the WebRTC encoder, which shows up as a static frame.
			window.electron.ipcRenderer.send('virtual-display-error', {
				event: 'quality-ignored',
				deviceID: partner.deviceID,
				value: requestedQuality,
			});
			return;
		}

		const maxVideoQualityMultiplier = requestedQuality;
		const minVideoQualityMultiplier =
			maxVideoQualityMultiplier === 1 ? 0.5 : maxVideoQualityMultiplier;

		const sourceID = peerConnection.desktopCapturerSourceID;

		if (!sourceID.includes(DesktopCapturerSourceType.SCREEN)) return;

		void peerConnection.replaceSharedVideoTrackWithQuality(
			minVideoQualityMultiplier,
			maxVideoQualityMultiplier,
		);
	}

	if (dataJSON.type === 'get_sharing_source_type') {
		if (peerConnection.isExtendedDisplayMode) {
			partner.peer?.send(
				prepareDataMessageToSendScreenSourceType('extended'),
			);
			return;
		}

		const sourceID = peerConnection.desktopCapturerSourceID;
		const sourceType = sourceID.includes(DesktopCapturerSourceType.SCREEN)
			? DesktopCapturerSourceType.SCREEN
			: DesktopCapturerSourceType.WINDOW;

		partner.peer?.send(prepareDataMessageToSendScreenSourceType(sourceType));
	}
}
