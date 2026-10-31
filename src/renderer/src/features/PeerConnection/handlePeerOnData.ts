import DesktopCapturerSourceType from '../../../../common/DesktopCapturerSourceType';
import type { HostPartnerConnection } from './index';
import prepareDataMessageToSendScreenSourceType from './prepareDataMessageToSendScreenSourceType';

export default function handlePeerOnData(
	peerConnection: PeerConnection,
	partner: HostPartnerConnection,
	data: string,
): void {
	let dataJSON: {
		type?: string;
		payload?: { value?: number };
	};
	try {
		dataJSON = JSON.parse(data);
	} catch (error) {
		console.error('failed to parse peer data message', error);
		return;
	}

	if (dataJSON.type === 'set_video_quality') {
		const requestedQuality = dataJSON.payload?.value;
		if (typeof requestedQuality !== 'number') return;

		const maxVideoQualityMultiplier = requestedQuality;
		const minVideoQualityMultiplier =
			maxVideoQualityMultiplier === 1 ? 0.5 : maxVideoQualityMultiplier;

		if (
			!peerConnection.desktopCapturerSourceID.includes(
				DesktopCapturerSourceType.SCREEN,
			)
		)
			return;

		void peerConnection.replaceSharedVideoTrackWithQuality(
			minVideoQualityMultiplier,
			maxVideoQualityMultiplier,
		);
	}

	if (dataJSON.type === 'get_sharing_source_type') {
		const sourceType = peerConnection.desktopCapturerSourceID.includes(
			DesktopCapturerSourceType.SCREEN,
		)
			? DesktopCapturerSourceType.SCREEN
			: DesktopCapturerSourceType.WINDOW;

		partner.peer?.send(prepareDataMessageToSendScreenSourceType(sourceType));
	}
}
