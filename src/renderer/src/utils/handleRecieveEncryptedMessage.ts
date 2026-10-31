import { IpcEvents } from '../../../common/IpcEvents.enum';
import { process as processMessage } from './message';

export type CallAcceptedMessageWithPayload = {
	type: 'CALL_ACCEPTED';
	payload: {
		signalData: string;
	};
};

export type CallUserMessageWithPayload = {
	type: 'CALL_USER';
	payload: {
		signalData: string;
	};
};

export type DeviceDetailsMessageWithPayload = {
	type: 'DEVICE_DETAILS';
	payload: {
		deviceType: string;
		os: string;
		browser: string;
		deviceScreenWidth: number;
		deviceScreenHeight: number;
	};
};

export type GetAppLanguageMessageWithPayload = {
	type: 'GET_APP_LANGUAGE';
	payload: Record<string, unknown>;
};

export type AppLanguageMessageWithPayload = {
	type: 'APP_LANGUAGE';
	payload: {
		value: string;
	};
};

export type DenyToConnectMessageWithPayload = {
	type: 'DENY_TO_CONNECT';
	payload: Record<string, unknown>;
};

export type AllowedToConnectMessageWithPayload = {
	type: 'ALLOWED_TO_CONNECT';
	payload: Record<string, unknown>;
};

export type DisconnectByHostMachineUserMessageWithPayload = {
	type: 'DISCONNECT_BY_HOST_MACHINE_USER';
	payload: Record<string, unknown>;
};

export type ProcessedMessage =
	| CallAcceptedMessageWithPayload
	| CallUserMessageWithPayload
	| DeviceDetailsMessageWithPayload
	| GetAppLanguageMessageWithPayload
	| AppLanguageMessageWithPayload
	| DenyToConnectMessageWithPayload
	| AllowedToConnectMessageWithPayload
	| DisconnectByHostMachineUserMessageWithPayload;

function getSenderUsername(payload: ReceiveEncryptedMessagePayload): string {
	const username = payload.payload?.username;
	return typeof username === 'string' ? username : '';
}

export function handleDeviceIPMessage(
	deviceIP: string,
	peerConnection: PeerConnection,
	message: DeviceDetailsMessageWithPayload,
	username: string,
): void {
	const partner = peerConnection.ensurePartner(username);

	const isNewDevice = partner.deviceID === '';
	const deviceID = partner.deviceID || Math.random().toString();

	const device = {
		id: deviceID,
		deviceIP,
		deviceType: message.payload.deviceType,
		deviceOS: message.payload.os,
		deviceBrowser: message.payload.browser,
		deviceScreenWidth: message.payload.deviceScreenWidth,
		deviceScreenHeight: message.payload.deviceScreenHeight,
		sharingSessionID: peerConnection.sharingSessionID,
		deviceRoomId: peerConnection.roomID,
	};

	partner.deviceID = device.id;
	partner.deviceDetails = device;

	if (isNewDevice) {
		peerConnection.onDeviceConnectedCallback(device);
	}
}

export const handleRecieveEncryptedMessage = async (
	peerConnection: PeerConnection,
	payload: ReceiveEncryptedMessagePayload,
): Promise<void> => {
	// A viewer can only talk to the host; ignore messages addressed to others.
	if (payload.to && payload.to !== peerConnection.user.username) return;

	const senderUsername = getSenderUsername(payload);
	if (!senderUsername) return;

	let message: ProcessedMessage;
	try {
		message = await processMessage(payload);
	} catch (e) {
		console.error('failed to process incoming message', e, payload);
		return;
	}

	if (message.type === 'CALL_ACCEPTED') {
		const partner = peerConnection.getPartnerByUsername(senderUsername);
		if (!partner?.peer) return;
		try {
			partner.peer.signal(message.payload.signalData);
		} catch (error) {
			console.error('failed to signal viewer peer', error);
		}
	}

	if (message.type === 'DEVICE_DETAILS') {
		peerConnection.socket.emit(
			'GET_IP_BY_SOCKET_ID',
			payload.fromSocketID,
			(deviceIP: string) => {
				// TODO: need to add myIP in client message.payload.myIP, then if retrieved deviceIP and myIP from client don't match, we were spoofed, then we can interrupt connection immediately!
				handleDeviceIPMessage(
					deviceIP,
					peerConnection,
					message,
					senderUsername,
				);
			},
		);
	}

	if (message.type === 'GET_APP_LANGUAGE') {
		const appLanguage = await window.electron.ipcRenderer.invoke(
			IpcEvents.GetAppLanguage,
		);
		await peerConnection.sendEncryptedMessage(
			{
				type: 'APP_LANGUAGE',
				payload: {
					value: appLanguage,
				},
			},
			senderUsername,
		);
	}
};
