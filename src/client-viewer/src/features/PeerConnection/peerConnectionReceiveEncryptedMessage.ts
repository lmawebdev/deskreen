import { ErrorMessage } from '../../components/ErrorDialog/ErrorMessageEnum';
import { process as processMessage } from '../../utils/message';
import PeerConnectionUserIsNotDefinedError from './errors/PeerConnectionUserIsNotDefinedError';
import NullUser from './NullUser';
import setAndShowErrorDialogMessage from './setAndShowErrorDialogMessage';

export default async (
	peerConnection: PeerConnection,
	payload: ReceiveEncryptedMessagePayload,
) => {
	if (peerConnection.user === NullUser) {
		throw new PeerConnectionUserIsNotDefinedError();
	}
	// The host sends every signaling message targeted to one viewer. Ignore
	// messages addressed to a different viewer in the same room.
	if (payload.to && payload.to !== peerConnection.user.username) return;
	const message = await processMessage(payload);

	// Messages from other viewers are broadcast to the whole room. Only the
	// host is a valid sender for this peer.
	const senderUsername = (message.payload as { username?: unknown })?.username;
	if (
		peerConnection.partner?.username &&
		typeof senderUsername === 'string' &&
		senderUsername !== peerConnection.partner.username
	) {
		return;
	}
	// const message = payload as any;
	if (message.type === 'CALL_USER') {
		peerConnection.peer?.signal(message.payload.signalData);
	}
	if (message.type === 'DENY_TO_CONNECT') {
		setAndShowErrorDialogMessage(peerConnection, ErrorMessage.DENY_TO_CONNECT);
	}
	if (message.type === 'DISCONNECT_BY_HOST_MACHINE_USER') {
		setAndShowErrorDialogMessage(peerConnection, ErrorMessage.DISCONNECTED);
	}
	if (message.type === 'ALLOWED_TO_CONNECT') {
		peerConnection.UIHandler.hostAllowedToConnectCallback();
	}
	if (message.type === 'APP_LANGUAGE') {
		peerConnection.UIHandler.setAppLanguageCallback(message.payload.value);
	}
};
