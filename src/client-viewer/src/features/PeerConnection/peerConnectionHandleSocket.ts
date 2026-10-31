import { ErrorMessage } from '../../components/ErrorDialog/ErrorMessageEnum';
import {
	getBrowserFromUAParser,
	getDeviceTypeFromUAParser,
	getOSFromUAParser,
} from '../../utils/userAgentParserHelpers';
import PeerConnectionSocketNotDefined from './errors/PeerConnectionSocketNotDefined';
import setAndShowErrorDialogMessage from './setAndShowErrorDialogMessage';

export function getMyIPCallback(
	peerConnection: PeerConnection,
	ip: string,
	userAgent: string,
) {
	peerConnection.myDeviceDetails.myIP = ip;

	peerConnection.uaParser.setUA(userAgent);
	peerConnection.myDeviceDetails.myOS = getOSFromUAParser(
		peerConnection.uaParser,
	);
	peerConnection.myDeviceDetails.myDeviceType = getDeviceTypeFromUAParser(
		peerConnection.uaParser,
	);
	peerConnection.myDeviceDetails.myBrowser = getBrowserFromUAParser(
		peerConnection.uaParser,
	);

	peerConnection.initApp(peerConnection.user, ip);
}

export default (peerConnection: PeerConnection) => {
	let disconnectCount = 0;
	let isAllowed = true;
	const socket = peerConnection.socket;
	if (!socket) {
		throw new PeerConnectionSocketNotDefined();
	}

	socket.on('disconnect', () => {
		disconnectCount++;
		// handle disconnect even when stream is started - stop stream and show error
		if (peerConnection.isStreamStarted && disconnectCount >= 1) {
			peerConnection.stopStream();
			setAndShowErrorDialogMessage(peerConnection, ErrorMessage.DISCONNECTED);
			return;
		}
		// for pre-stream disconnects, wait for sustained disconnection before showing error
		if (disconnectCount > 6 && isAllowed) {
			setAndShowErrorDialogMessage(peerConnection, ErrorMessage.DISCONNECTED);
		}
	});

	socket.on('connect', () => {
		let ipCallbackReceived = false;
		// A reconnect gets a fresh room entry on the server, so the host must
		// receive this viewer's details again.
		peerConnection.hasSentDeviceDetails = false;

		// clear any existing reconnect timeout
		if (peerConnection.reconnectTimeout) {
			clearTimeout(peerConnection.reconnectTimeout);
		}

		peerConnection.reconnectTimeout = setTimeout(() => {
			if (!ipCallbackReceived && isAllowed) {
				console.log('GET_MY_IP callback not received, reconnecting socket');
				socket.disconnect();
				socket.connect();
			}
		}, 2500); // 2 seconds timeout to wait for callback

		// clear any existing getMyIP timeout
		if (peerConnection.getMyIPTimeout) {
			clearTimeout(peerConnection.getMyIPTimeout);
		}

		peerConnection.getMyIPTimeout = setTimeout(() => {
			if (!isAllowed) return;
			socket.emit('GET_MY_IP', (ip: string) => {
				console.log('GET_MY_IP', ip);
				ipCallbackReceived = true;
				if (peerConnection.reconnectTimeout) {
					clearTimeout(peerConnection.reconnectTimeout);
					peerConnection.reconnectTimeout = null;
				}
				getMyIPCallback(peerConnection, ip, window.navigator.userAgent);
			});
		}, 500);
	});

	socket.on('NOT_ALLOWED', () => {
		isAllowed = false;
		setAndShowErrorDialogMessage(peerConnection, ErrorMessage.NOT_ALLOWED);
	});

	socket.on(
		'USER_ENTER',
		(payload: { users: PartnerPeerUser[]; ownerUsername?: string }) => {
			if (!isAllowed) return;

			const users = payload.users || [];
			const partner =
				users.find((u) => u.isOwner && u.username === payload.ownerUsername) ??
				users.find((u) => u.isOwner);

			if (!partner) return;

			peerConnection.partner = partner;

			// DEVICE_DETAILS must be sent exactly once per viewer. USER_ENTER is
			// re-broadcast every time another viewer joins the room.
			if (peerConnection.hasSentDeviceDetails) return;
			peerConnection.hasSentDeviceDetails = true;

			peerConnection.sendEncryptedMessage({
				type: 'DEVICE_DETAILS',
				// TODO: add deviceIP in this payload
				payload: {
					os: peerConnection.myDeviceDetails.myOS,
					deviceType: peerConnection.myDeviceDetails.myDeviceType,
					browser: peerConnection.myDeviceDetails.myBrowser,
					deviceScreenWidth: window.screen.width,
					deviceScreenHeight: window.screen.height,
				},
			});

			peerConnection.sendEncryptedMessage({
				type: 'GET_APP_LANGUAGE',
				payload: {},
			});

			// clear any existing timeout
			if (peerConnection.setMyDeviceDetailsTimeout) {
				clearTimeout(peerConnection.setMyDeviceDetailsTimeout);
			}

			peerConnection.setMyDeviceDetailsTimeout = setTimeout(() => {
				peerConnection.UIHandler.setMyDeviceDetails({
					myIP: peerConnection.myDeviceDetails.myIP,
					myOS: peerConnection.myDeviceDetails.myOS,
					myBrowser: peerConnection.myDeviceDetails.myBrowser,
					myDeviceType: peerConnection.myDeviceDetails.myDeviceType,
					myRoomId: peerConnection.roomId,
				});
			}, 100);
		},
	);

	// peerConnection.socket.on('USER_EXIT', (payload: any) => {
	//   // peerConnection.props.receiveUnencryptedMessage('USER_EXIT', payload);
	// });

	socket.on('MESSAGE', (payload: ReceiveEncryptedMessagePayload) => {
		if (!isAllowed) return;
		peerConnection.receiveEncryptedMessage(payload);
	});

	socket.on('ROOM_LOCKED', () => {
		setAndShowErrorDialogMessage(peerConnection, ErrorMessage.DENY_TO_CONNECT);
	});
};
