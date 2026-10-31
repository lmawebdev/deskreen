import { ErrorMessage } from '../../components/ErrorDialog/ErrorMessageEnum';
import { PLAYER_WRAPPER_ID } from '../../constants/appConstants';
import {
	getBrowserFromUAParser,
	getDeviceTypeFromUAParser,
	getOSFromUAParser,
} from '../../utils/userAgentParserHelpers';
import PeerConnectionSocketNotDefined from './errors/PeerConnectionSocketNotDefined';
import setAndShowErrorDialogMessage from './setAndShowErrorDialogMessage';

export function getVideoAreaSize(): { width: number; height: number } {
	const wrapper = document.getElementById(PLAYER_WRAPPER_ID);
	const cssWidth = wrapper?.clientWidth ?? window.innerWidth;
	const cssHeight = wrapper?.clientHeight ?? window.innerHeight;

	// The virtual display must be sized in physical pixels: on a phone with
	// devicePixelRatio 3 a 360x800 CSS area would otherwise create a tiny
	// 360x800 monitor and the stream would look blurry.
	const dpr = window.devicePixelRatio || 1;

	return {
		width: Math.max(1, Math.round(cssWidth * dpr)),
		height: Math.max(1, Math.round(cssHeight * dpr)),
	};
}

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
		if (peerConnection.getMyIPRetryInterval) {
			clearInterval(peerConnection.getMyIPRetryInterval);
			peerConnection.getMyIPRetryInterval = null;
		}
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

		if (peerConnection.getMyIPTimeout) {
			clearTimeout(peerConnection.getMyIPTimeout);
		}
		if (peerConnection.getMyIPRetryInterval) {
			clearInterval(peerConnection.getMyIPRetryInterval);
			peerConnection.getMyIPRetryInterval = null;
		}

		const requestMyIP = (): void => {
			if (ipCallbackReceived || !isAllowed || !socket.connected) return;
			socket.emit('GET_MY_IP', (ip: string) => {
				if (ipCallbackReceived) return;
				console.log('GET_MY_IP', ip);
				ipCallbackReceived = true;
				if (peerConnection.reconnectTimeout) {
					clearTimeout(peerConnection.reconnectTimeout);
					peerConnection.reconnectTimeout = null;
				}
				if (peerConnection.getMyIPTimeout) {
					clearTimeout(peerConnection.getMyIPTimeout);
					peerConnection.getMyIPTimeout = null;
				}
				if (peerConnection.getMyIPRetryInterval) {
					clearInterval(peerConnection.getMyIPRetryInterval);
					peerConnection.getMyIPRetryInterval = null;
				}
				getMyIPCallback(peerConnection, ip, window.navigator.userAgent);
			});
		};

		peerConnection.reconnectTimeout = setTimeout(() => {
			if (!ipCallbackReceived && isAllowed) {
				console.log('GET_MY_IP callback not received, reconnecting socket');
				socket.disconnect();
				socket.connect();
			}
		}, 2500);

		// The signaling server registers its handlers ~500ms after the
		// connection, so an immediate GET_MY_IP can be lost. Retry until the
		// server acknowledges.
		peerConnection.getMyIPTimeout = setTimeout(requestMyIP, 500);
		peerConnection.getMyIPRetryInterval = setInterval(requestMyIP, 500);
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

			const videoArea = getVideoAreaSize();
			peerConnection.sendEncryptedMessage({
				type: 'DEVICE_DETAILS',
				// TODO: add deviceIP in this payload
				payload: {
					os: peerConnection.myDeviceDetails.myOS,
					deviceType: peerConnection.myDeviceDetails.myDeviceType,
					browser: peerConnection.myDeviceDetails.myBrowser,
					deviceScreenWidth: videoArea.width,
					deviceScreenHeight: videoArea.height,
				},
			});

			peerConnection.sendEncryptedMessage({
				type: 'GET_APP_LANGUAGE',
				payload: {},
			});

			// The player wrapper may still be mounting when DEVICE_DETAILS is
			// sent, so send the final video area size once the UI settles. The
			// host uses it to resize the virtual display to the viewer aspect.
			for (const delay of [800, 2000, 4000]) {
				setTimeout(sendScreenSize, delay);
			}

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

	let lastSize: { width: number; height: number } | null = null;
	let screenSizeTimer: NodeJS.Timeout | null = null;

	function sendScreenSize(): void {
		if (!peerConnection.partner?.username) return;
		const { width, height } = getVideoAreaSize();
		if (width <= 0 || height <= 0) return;
		if (lastSize && lastSize.width === width && lastSize.height === height) {
			return;
		}
		lastSize = { width, height };

		peerConnection.sendEncryptedMessage({
			type: 'SCREEN_SIZE_CHANGED',
			payload: {
				width,
				height,
			},
		});
	}

	function scheduleScreenSize(): void {
		if (screenSizeTimer) clearTimeout(screenSizeTimer);
		screenSizeTimer = setTimeout(sendScreenSize, 500);
	}

	window.addEventListener('orientationchange', scheduleScreenSize);
	window.addEventListener('resize', scheduleScreenSize);
	document.addEventListener('fullscreenchange', scheduleScreenSize);
	document.addEventListener('webkitfullscreenchange', scheduleScreenSize);
	if (window.screen.orientation) {
		window.screen.orientation.addEventListener('change', scheduleScreenSize);
	}
};
