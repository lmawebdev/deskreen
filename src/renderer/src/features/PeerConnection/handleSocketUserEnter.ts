export default (
	peerConnection: PeerConnection,
	payload: { users: PartnerPeerUser[]; ownerUsername?: string },
): void => {
	const users = payload.users || [];

	if (users.some((user) => user.username === peerConnection.user.username)) {
		peerConnection.hasJoinedRoom = true;
	}

	for (const user of users) {
		if (user.username === peerConnection.user.username) continue;
		// Only non-owner sockets are viewers. A stale owner entry must never
		// become a partner.
		if (user.isOwner) continue;

		const partner = peerConnection.ensurePartner(user.username);
		partner.socketId = user.socketId;
	}

	const usernames = new Set(users.map((user) => user.username));
	peerConnection.removePartnersNotIn(usernames);
};
