import DesktopCapturerSourceType from '../../../../common/DesktopCapturerSourceType';
import { isTestMode } from '../../../../common/runtimeEnv';
import getDesktopSourceStreamBySourceID from './getDesktopSourceStreamBySourceID';

export default async function createDesktopCapturerStream(
	peerConnection: PeerConnection,
	sourceID: string,
): Promise<void> {
	try {
		if (isTestMode()) return;

		if (sourceID.includes(DesktopCapturerSourceType.SCREEN)) {
			const stream = await getDesktopSourceStreamBySourceID(
				sourceID,
				peerConnection.sourceDisplaySize?.width,
				peerConnection.sourceDisplaySize?.height,
				0.5,
				1,
			);
			peerConnection.localStream = stream;
		} else {
			// when source is app window
			const stream = await getDesktopSourceStreamBySourceID(sourceID);
			peerConnection.localStream = stream;
		}
	} catch (e) {
		console.error(e);
	}
}
