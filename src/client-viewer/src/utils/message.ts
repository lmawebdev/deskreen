import type { LocalPeerUser } from '../../../common/LocalPeerUser';
import type { SendEncryptedMessagePayload } from '../../../common/SendEncryptedMessagePayload';

export type OutgoingMessage = ProcessedMessage & { to?: string };

export interface ProcessedPayload {
	toSend: OutgoingMessage;
	original: OutgoingMessage;
}

export const process = (
	payload: ReceiveEncryptedMessagePayload,
): Promise<ProcessedMessage> => Promise.resolve(payload as ProcessedMessage);

export const prepare = (
	payload: SendEncryptedMessagePayload,
	user: LocalPeerUser,
	targetUsername?: string,
): Promise<ProcessedPayload> =>
	new Promise((resolve) => {
		const myUsername = user.username;
		const myId = user.id;
		const innerPayload = { ...payload.payload } as Record<string, unknown>;
		if (typeof (innerPayload as { text?: unknown }).text === 'string') {
			(innerPayload as { text?: string }).text = encodeURI(
				(innerPayload as { text?: string }).text as string,
			);
		}
		const jsonToSend = {
			...payload,
			...(targetUsername ? { to: targetUsername } : {}),
			payload: {
				...innerPayload,
				sender: myId,
				username: myUsername,
			},
		} as OutgoingMessage;

		resolve({
			toSend: jsonToSend,
			original: jsonToSend,
		});
	});
