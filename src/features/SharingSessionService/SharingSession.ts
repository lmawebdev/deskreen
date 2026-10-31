import { BrowserWindow } from 'electron';
import uuid from 'uuid';
import { Device } from '../../common/Device';
import { LocalPeerUser } from '../../common/LocalPeerUser';
import PeerConnectionHelperRendererService from '../PeerConnectionHelperRendererService';
import SharingSessionStatusEnum from './SharingSessionStatusEnum';
import SharingTypeEnum from './SharingTypeEnum';

export type SharingSessionStatusChangeListener = (
	sharingSessionID: string,
) => void;

export default class SharingSession {
	id: string;
	sharingType: SharingTypeEnum;
	sharingStream: MediaStream | null;
	roomID: string;
	connectedDeviceAt: Date | null;
	sharingStartedAt: Date | null;
	status: SharingSessionStatusEnum;
	statusChangeListeners: SharingSessionStatusChangeListener[];
	peerConnectionHelperRenderer: BrowserWindow | undefined;
	onDeviceConnectedCallback: undefined | ((device: Device) => void);
	desktopCapturerSourceID: string;
	firstViewerDeviceID: string;

	constructor(
		_roomID: string,
		user: LocalPeerUser,
		peerConnectionHelperRendererService: PeerConnectionHelperRendererService,
	) {
		this.id = uuid.v4();
		this.sharingType = SharingTypeEnum.NOT_SET;
		this.sharingStream = null;
		this.roomID = _roomID;
		this.connectedDeviceAt = null;
		this.sharingStartedAt = null;
		this.status = SharingSessionStatusEnum.NOT_CONNECTED;
		this.statusChangeListeners = [] as SharingSessionStatusChangeListener[];
		this.desktopCapturerSourceID = '';
		this.firstViewerDeviceID = '';
		this.onDeviceConnectedCallback = undefined;

		if (process.env.RUN_MODE === 'test') return;

		this.peerConnectionHelperRenderer =
			peerConnectionHelperRendererService.createPeerConnectionHelperRenderer();

		this.peerConnectionHelperRenderer.webContents.on('did-finish-load', () => {
			// TODO: I need to remove dependency on renderer window, just to facilitate development
			// TODO: OR I can use a Utility or Child process to handle this. https://electron-vite.org/guide/dev#utility-process-and-child-process
			// TODO: probably using worker thread is the best option, but it will use the same resources as the main thread. child process is using more resources, but it is more isolated.
			// TODO: https://github.com/alex8088/electron-vite-worker-example
			this.peerConnectionHelperRenderer?.webContents.send(
				'create-peer-connection-with-data',
				{
					roomID: this.roomID,
					sharingSessionID: this.id,
					user,
				},
			);
		});

		this.peerConnectionHelperRenderer.webContents.on(
			'ipc-message',
			(_, channel, data) => {
				if (channel === 'peer-connected') {
					if (this.onDeviceConnectedCallback) {
						this.onDeviceConnectedCallback(data);
					}
				}
			},
		);
	}

	destroy(): void {
		this.peerConnectionHelperRenderer?.close();
	}

	setOnDeviceConnectedCallback(callback: (device: Device) => void): void {
		this.onDeviceConnectedCallback = callback;
	}

	setDesktopCapturerSourceID(id: string): void {
		this.desktopCapturerSourceID = id;
		if (process.env.RUN_MODE === 'test') return;
		this.peerConnectionHelperRenderer?.webContents.send(
			'set-desktop-capturer-source-id',
			id,
		);
	}

	callPeer(deviceID?: string): void {
		if (process.env.RUN_MODE === 'test') return;
		this.sendToHelperRenderer('call-peer', deviceID);
	}

	sendUserAllowedToConnect(deviceID?: string): void {
		this.sendToHelperRenderer('send-user-allowed-to-connect', deviceID);
	}

	disconnectByHostMachineUser(deviceID?: string): void {
		this.sendToHelperRenderer('disconnect-by-host-machine-user', deviceID);
	}

	denyConnectionForPartner(deviceID?: string): void {
		this.sendToHelperRenderer('deny-connection-for-partner', deviceID);
	}

	appLanguageChanged(): void {
		this.sendToHelperRenderer('app-language-changed');
	}

	private sendToHelperRenderer(channel: string, ...args: unknown[]): void {
		const helper = this.peerConnectionHelperRenderer;
		if (!helper || helper.isDestroyed()) return;
		helper.webContents.send(channel, ...args);
	}

	addStatusChangeListener(callback: SharingSessionStatusChangeListener): void {
		this.statusChangeListeners.push(callback);
	}

	notifyStatusChangeListeners(): Promise<undefined> {
		return new Promise((resolve) => {
			for (let i = 0; i < this.statusChangeListeners.length; i += 1) {
				this.statusChangeListeners[i](this.id);
			}
			resolve(undefined);
		});
	}

	setStatus(newStatus: SharingSessionStatusEnum): void {
		this.status = newStatus;
		this.notifyStatusChangeListeners();
	}
}
