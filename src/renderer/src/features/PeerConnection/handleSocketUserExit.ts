export default (
	peerConnection: PeerConnection,
	users: PartnerPeerUser[],
): void => {
	const remainingUsernames = new Set(
		(users || []).map((user) => user.username),
	);
	const hadPartners = peerConnection.partners.size > 0;

	peerConnection.removePartnersNotIn(remainingUsernames);

	if (
		hadPartners &&
		peerConnection.partners.size === 0 &&
		peerConnection.hasStartedSharing
	) {
		// Last viewer left: close the session like the single viewer flow.
		peerConnection.selfDestroy();
	}
};
