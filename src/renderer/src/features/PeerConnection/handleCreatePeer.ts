import handlePeerOnData from './handlePeerOnData';
import type { HostPartnerConnection } from './index';
import setSdpMediaBitrate from './setSdpMediaBitrate';

type SimplePeerInstance = InstanceType<typeof import('simple-peer')>;

export default function handleCreatePeer(
	peerConnection: PeerConnection,
	partner: HostPartnerConnection,
): Promise<void> {
	return new Promise((resolve) => {
		if (partner.peer) {
			resolve();
			return;
		}

		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore SimplePeer is loaded as a global by the helper window
		const peer = new SimplePeer({
			initiator: true,
			config: { iceServers: [] },
			sdpTransform: (sdp: string) =>
				setSdpMediaBitrate(sdp, 'video', 100000000),
		}) as SimplePeerInstance;

		partner.peer = peer;

		const stream = peerConnection.getStreamForPartner(partner);
		if (stream !== null) {
			stream.getVideoTracks().forEach((track) => {
				track.contentHint = 'text';
			});
			peer.addStream(stream);
			partner.hasStream = true;
			partner.stream = stream;
			partner.currentTrack = stream.getVideoTracks()[0] ?? null;
			void peerConnection.configurePeerForHighQuality(partner);
		}

		peer.on('signal', (data: unknown) => {
			if (partner.peer !== peer) return;
			if (partner.isCallStarted) {
				void peerConnection.sendEncryptedMessage(
					{
						type: 'CALL_USER',
						payload: {
							signalData: data,
						},
					},
					partner.username,
				);
			} else {
				partner.signals.push(data);
			}
		});

		peer.on('connect', () => {
			void peerConnection.configurePeerForHighQuality(partner);
		});

		peer.on('data', (data: string) => {
			void handlePeerOnData(peerConnection, partner, data);
		});

		peer.on('close', () => {
			peerConnection.handlePartnerPeerClosed(partner.username, peer);
		});

		peer.on('error', (e: Error) => {
			console.error('peerConnection peer error', e);
			window.electron.ipcRenderer.send('virtual-display-error', {
				deviceID: partner.deviceID,
				message: `peer error: ${String(e)}`,
			});
			peerConnection.handlePartnerPeerClosed(partner.username, peer);
		});

		resolve();
	});
}
