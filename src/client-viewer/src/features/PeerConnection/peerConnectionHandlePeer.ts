import { ErrorMessage } from '../../components/ErrorDialog/ErrorMessageEnum';
import { VideoQuality } from '../VideoAutoQualityOptimizer/VideoQualityEnum';
import PeerConnectionPeerIsNullError from './errors/PeerConnectionPeerIsNullError';
import { ScreenSharingSource } from './ScreenSharingSourceEnum';
import { getVideoAreaSize } from './peerConnectionHandleSocket';
import {
	prepareDataMessageToChangeQuality,
	prepareDataMessageToGetSharingSourceType,
} from './simplePeerDataMessages';

export function getSharingShourceType(peerConnection: PeerConnection) {
	try {
		peerConnection.peer?.send(prepareDataMessageToGetSharingSourceType());
	} catch (e) {
		console.log(e);
	}
}

export default (peerConnection: PeerConnection) => {
	if (peerConnection.peer === null) {
		throw new PeerConnectionPeerIsNullError();
	}
	peerConnection.peer.on('stream', (stream) => {
		peerConnection.setUrlCallback(stream);

		// Ask Chromium for the lowest playout delay. These are non-standard
		// hints but are supported by Chromium and some Safari versions.
		try {
			const pc = (
				peerConnection.peer as unknown as {
					_pc?: RTCPeerConnection;
				}
			)._pc;
			pc?.getReceivers().forEach((receiver) => {
				const lowLatencyReceiver = receiver as RTCRtpReceiver & {
					jitterBufferTarget?: number;
				};
				lowLatencyReceiver.jitterBufferTarget = 0;

				const track = receiver.track as MediaStreamTrack & {
					playoutDelayHint?: number;
				};
				if (track?.kind === 'video') {
					track.playoutDelayHint = 0;
				}
			});

			const videoTrack = stream.getVideoTracks()[0] as
				| (MediaStreamTrack & { playoutDelayHint?: number })
				| undefined;
			if (videoTrack) {
				videoTrack.playoutDelayHint = 0;
			}
		} catch {
			// best-effort low-latency hints
		}

		// Once the video is visible, tell the host the exact player size so it
		// can resize the virtual display to the same aspect ratio. Sending it
		// here guarantees the display already exists on the host.
		setTimeout(() => {
			const { width, height } = getVideoAreaSize();
			if (width <= 0 || height <= 0) return;
			void peerConnection.sendEncryptedMessage({
				type: 'SCREEN_SIZE_CHANGED',
				payload: { width, height },
			});
		}, 1500);

		setTimeout(() => {
			peerConnection.videoAutoQualityOptimizer.setGoodQualityCallback(() => {
				if (peerConnection.videoQuality === VideoQuality.Q_AUTO) {
					try {
						peerConnection.peer?.send(prepareDataMessageToChangeQuality(1));
					} catch (e) {
						console.log(e);
					}
				}
			});

			peerConnection.videoAutoQualityOptimizer.setHalfQualityCallbak(() => {
				if (peerConnection.videoQuality === VideoQuality.Q_AUTO) {
					try {
						peerConnection.peer?.send(prepareDataMessageToChangeQuality(0.5));
					} catch (e) {
						console.log(e);
					}
				}
			});
		}, 1000);

		peerConnection.videoAutoQualityOptimizer.startOptimizationLoop();

		setTimeout(getSharingShourceType, 1000, peerConnection);

		peerConnection.isStreamStarted = true;

		// if any transient error dialog was shown earlier, close it now
		try {
			peerConnection.UIHandler.setIsErrorDialogOpen(false);
			peerConnection.UIHandler.errorDialogMessage = ErrorMessage.UNKNOWN_ERROR;
		} catch (_) {
			// ignore
		}
	});

	peerConnection.peer.on('signal', (data) => {
		// fired when webrtc done preparation to start call on peerConnection machine
		peerConnection.sendEncryptedMessage({
			type: 'CALL_ACCEPTED',
			payload: {
				signalData: data,
			},
		});
	});

	peerConnection.peer.on('data', (data) => {
		const dataJSON = JSON.parse(data);

		if (dataJSON.type === 'screen_sharing_source_type') {
			peerConnection.screenSharingSourceType = dataJSON.payload.value;
			if (
				peerConnection.screenSharingSourceType === ScreenSharingSource.SCREEN ||
				peerConnection.screenSharingSourceType === ScreenSharingSource.WINDOW ||
				peerConnection.screenSharingSourceType ===
					ScreenSharingSource.EXTENDED
			) {
				peerConnection.UIHandler.setScreenSharingSourceTypeCallback(
					peerConnection.screenSharingSourceType,
				);
			}
		}
	});
};
