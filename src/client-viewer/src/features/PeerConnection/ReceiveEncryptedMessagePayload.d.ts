interface ReceiveEncryptedMessagePayload {
	fromSocketID: string;
	to?: string;
	type: string;
	payload: Record<string, unknown>;
}
