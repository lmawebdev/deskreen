import { IpcEvents } from '../../../../common/IpcEvents.enum';

export default function handleSelfDestroy(
	peerConnection: PeerConnection,
): void {
	peerConnection.destroyAllPartners(false);

	// remove window event listener
	if (peerConnection.beforeunloadHandler) {
		window.removeEventListener(
			'beforeunload',
			peerConnection.beforeunloadHandler,
		);
		peerConnection.beforeunloadHandler = null;
	}

	// cleanup shared media stream once all peers are gone
	peerConnection.stopLocalStream();

	// cleanup socket
	peerConnection.socket.removeAllListeners();
	peerConnection.socket.disconnect();

	window.electron.ipcRenderer.invoke(
		IpcEvents.DestroySharingSessionById,
		peerConnection.sharingSessionID,
	);
	peerConnection.onDeviceConnectedCallback = () => {
		// reset callback after destruction
	};
	peerConnection.hasStartedSharing = false;
}
