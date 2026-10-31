import handleSocketUserEnter from './handleSocketUserEnter';
import handleSocketUserExit from './handleSocketUserExit';

export default function handleSocket(peerConnection: PeerConnection): void {
	peerConnection.socket.removeAllListeners();

	peerConnection.socket.on('disconnect', () => {
		peerConnection.selfDestroy();
	});

	peerConnection.socket.on('error', (error: Error) => {
		console.error('peerConnection socket error', error);
		peerConnection.selfDestroy();
	});

	peerConnection.socket.on('connect', () => {
		peerConnection.hasJoinedRoom = false;
		let attempts = 0;

		const emitUserEnter = (): void => {
			if (peerConnection.hasJoinedRoom || peerConnection.isDestroyed) return;
			peerConnection.emitUserEnter();
		};

		// The signaling server registers its handlers ~500ms after the
		// connection, so an immediate USER_ENTER can be lost. Retry until the
		// room broadcasts us back.
		emitUserEnter();
		const retryInterval = setInterval(() => {
			attempts += 1;
			if (
				peerConnection.hasJoinedRoom ||
				peerConnection.isDestroyed ||
				attempts > 10
			) {
				clearInterval(retryInterval);
				return;
			}
			emitUserEnter();
		}, 600);

		peerConnection.socket.once('disconnect', () => {
			clearInterval(retryInterval);
		});
	});

	peerConnection.socket.on(
		'USER_ENTER',
		(payload: { users: PartnerPeerUser[]; ownerUsername?: string }) => {
			handleSocketUserEnter(peerConnection, payload);
		},
	);

	peerConnection.socket.on('USER_EXIT', (users: PartnerPeerUser[]) => {
		handleSocketUserExit(peerConnection, users);
	});

	peerConnection.socket.on(
		'MESSAGE',
		(payload: ReceiveEncryptedMessagePayload) => {
			peerConnection.receiveEncryptedMessage(payload);
		},
	);
}
