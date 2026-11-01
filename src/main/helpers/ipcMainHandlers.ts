import {
	app,
	BrowserWindow,
	clipboard,
	Display,
	ipcMain,
	screen,
	shell,
} from 'electron';
import DesktopCapturerSourceType from '../../common/DesktopCapturerSourceType';
import { store } from '../../common/deskreen-electron-store';
import { ElectronStoreKeys } from '../../common/ElectronStoreKeys.enum';
import { IpcEvents } from '../../common/IpcEvents.enum';
import SharingSession from '../../features/SharingSessionService/SharingSession';
import SharingSessionStatusEnum from '../../features/SharingSessionService/SharingSessionStatusEnum';
import SharingTypeEnum from '../../features/SharingSessionService/SharingTypeEnum';
import { signalingServer } from '../../server';
import { onDeviceConnectedCallback } from '../../server/onDeviceConnectedCallback';
import i18n from '../configs/i18next.config';
import isLinuxWaylandSession from '../utils/isLinuxWaylandSession';
import { checkScreenRecordingPermission } from './checkScreenRecordingPermission';
import {
	getExtendedDisplaySettings,
	saveExtendedDisplaySettings,
} from './extendedDisplaySettings';
import { getDeskreenGlobal } from './getDeskreenGlobal';
import getMyLocalIpV4 from './getMyLocalIpV4';
import isWifiConnected from './isWifiConnected';

export const initIpcMainHandlers = (mainWindow: BrowserWindow): void => {
	/**
	 * Releases a room id unless another live session already owns it. Rooms
	 * must never stay reserved after their session is gone, otherwise a viewer
	 * can still open the old link and wait forever in an ownerless room.
	 */
	function releaseRoomID(roomID: string): void {
		if (!roomID) return;
		const { sharingSessionService } = getDeskreenGlobal();
		const isRoomInUse =
			sharingSessionService.waitingForConnectionSharingSession?.roomID ===
				roomID ||
			[...sharingSessionService.sharingSessions.values()].some(
				(session) =>
					session.roomID === roomID &&
					session.status !== SharingSessionStatusEnum.DESTROYED,
			);
		if (isRoomInUse) return;
		getDeskreenGlobal().roomIDService.unmarkRoomIDAsTaken(roomID);
	}

	getDeskreenGlobal().virtualDisplayService.setResizeListener((info) => {
		const session =
			getDeskreenGlobal().sharingSessionService.sharingSessions.get(
				info.sharingSessionID,
			);
		session?.setPartnerDesktopCapturerSourceID(
			info.deviceID,
			info.sourceID,
			info.width,
			info.height,
		);
	});

	ipcMain.on('client-changed-language', async (_, newLangCode) => {
		i18n.changeLanguage(newLangCode);
		if (store.has(ElectronStoreKeys.AppLanguage)) {
			if (store.get(ElectronStoreKeys.AppLanguage) === newLangCode) {
				return;
			}
			store.delete(ElectronStoreKeys.AppLanguage);
		}
		store.set(ElectronStoreKeys.AppLanguage, newLangCode);
	});

	ipcMain.on('virtual-display-error', (_, payload) => {
		console.error('[virtual-display]', payload);
	});

	ipcMain.on(
		'partner-screen-size-changed',
		(_, payload: { deviceID: string; width: number; height: number }) => {
			if (
				!payload?.deviceID ||
				!Number.isFinite(payload.width) ||
				!Number.isFinite(payload.height)
			) {
				return;
			}

			const deskreenGlobal = getDeskreenGlobal();
			deskreenGlobal.connectedDevicesService.updateDeviceScreenSize(
				payload.deviceID,
				payload.width,
				payload.height,
			);
			void deskreenGlobal.virtualDisplayService.resize(
				payload.deviceID,
				payload.width,
				payload.height,
			);
		},
	);

	ipcMain.handle('get-signaling-server-port', () => {
		if (mainWindow === null) return;
		mainWindow.webContents.send('sending-port-from-main', signalingServer.port);
	});

	ipcMain.handle('get-all-displays', () => {
		return screen.getAllDisplays();
	});

	ipcMain.handle('get-display-size-by-display-id', (_, displayID: string) => {
		const display = screen.getAllDisplays().find((d: Display) => {
			return `${d.id}` === displayID;
		});

		if (display) {
			return display.size;
		}
		return undefined;
	});

	ipcMain.handle(IpcEvents.GetIsLinuxWaylandSession, () => {
		return isLinuxWaylandSession;
	});

	ipcMain.handle(
		IpcEvents.RequestDesktopCapturerPortalSource,
		async (_, { mode }: { mode: 'screen' | 'window' }) => {
			const types =
				mode === 'window'
					? [DesktopCapturerSourceType.WINDOW]
					: [DesktopCapturerSourceType.SCREEN];

			if (!isLinuxWaylandSession) {
				await getDeskreenGlobal().desktopCapturerSourcesService.refreshDesktopCapturerSources();
				if (mode === 'window') {
					const sources =
						getDeskreenGlobal().desktopCapturerSourcesService.getAppWindowSources();
					return sources[0]?.id ?? null;
				}
				const sources =
					getDeskreenGlobal().desktopCapturerSourcesService.getScreenSources();
				return sources[0]?.id ?? null;
			}

			const source =
				await getDeskreenGlobal().desktopCapturerSourcesService.requestPortalSource(
					types,
				);
			return source?.id ?? null;
		},
	);

	ipcMain.handle('main-window-onbeforeunload', () => {
		const deskreenGlobal = getDeskreenGlobal();

		// Never replace roomIDService / connectedDevicesService here: the
		// signaling server validates rooms against deskreenGlobal.roomIDService
		// and SharingSessionService keeps its own reference to the instance it
		// was built with. Replacing them left every room created afterwards
		// unmarked for the server, so the helper socket was rejected with
		// NOT_ALLOWED and the app regenerated a dead room link forever.
		deskreenGlobal.virtualDisplayService.destroyAll();

		// Free viewers first, while the sessions still exist: the availability
		// listener must not create a new waiting session during a reload/quit.
		deskreenGlobal.connectedDevicesService.disconnectAllDevices();

		const roomIDs: string[] = [];
		deskreenGlobal.sharingSessionService.sharingSessions.forEach(
			(sharingSession: SharingSession) => {
				sharingSession.denyConnectionForPartner();
				roomIDs.push(sharingSession.roomID);
				sharingSession.destroy();
			},
		);

		deskreenGlobal.rendererWebrtcHelpersService.helpers.forEach(
			(helperWindow) => {
				helperWindow.close();
			},
		);

		deskreenGlobal.sharingSessionService.waitingForConnectionSharingSession =
			null;
		deskreenGlobal.rendererWebrtcHelpersService.helpers.clear();
		deskreenGlobal.sharingSessionService.sharingSessions.clear();
		roomIDs.forEach(releaseRoomID);
	});

	ipcMain.handle('get-current-version', () => {
		return getDeskreenGlobal().currentAppVersion;
	});

	ipcMain.handle('get-local-lan-ip', async () => {
		const deskreenGlobal = getDeskreenGlobal();
		if (deskreenGlobal.cliLocalIp) {
			return deskreenGlobal.cliLocalIp;
		}
		const ip = getMyLocalIpV4();
		return ip;
	});

	ipcMain.handle('check-wifi-connection', async () => {
		return isWifiConnected();
	});

	ipcMain.handle(IpcEvents.GetPort, () => {
		return signalingServer.port;
	});

	ipcMain.handle(IpcEvents.GetAppPath, () => {
		const deskreenGlobal = getDeskreenGlobal();
		return deskreenGlobal.appPath;
	});

	ipcMain.handle(IpcEvents.UnmarkRoomIDAsTaken, (_, roomID) => {
		releaseRoomID(roomID);
	});

	async function createWaitingForConnectionSharingSession(
		roomID?: string,
	): Promise<void> {
		try {
			const deskreenGlobal = getDeskreenGlobal();
			if (
				deskreenGlobal.sharingSessionService
					.waitingForConnectionSharingSession !== null
			) {
				return;
			}
			// While a session is sharing, the QR shown by the stepper points to
			// that active room, so a new waiting session must not be created.
			if (
				[...deskreenGlobal.sharingSessionService.sharingSessions.values()].some(
					(session) =>
						session.status === SharingSessionStatusEnum.SHARING ||
						session.status === SharingSessionStatusEnum.CONNECTED,
				)
			) {
				return;
			}
			const waitingSession =
				await deskreenGlobal.sharingSessionService.createWaitingForConnectionSharingSession(
					roomID,
				);
			waitingSession.setOnDeviceConnectedCallback(onDeviceConnectedCallback);
		} catch (error) {
			console.error('Failed to create waiting sharing session', error);
		}
	}

	ipcMain.handle(
		IpcEvents.CreateWaitingForConnectionSharingSession,
		async (_, roomID?: string) => {
			await createWaitingForConnectionSharingSession(roomID);
		},
	);

	function resetWaitingForConnectionSharingSession(): void {
		const deskreenGlobal = getDeskreenGlobal();
		const sharingSession =
			deskreenGlobal.sharingSessionService.waitingForConnectionSharingSession;
		const roomID = sharingSession?.roomID;

		// Any viewer still pending for this room is disconnected when the
		// waiting session is reset.
		deskreenGlobal.connectedDevicesService
			.getPendingConnectionDevices()
			.filter((device) => device.sharingSessionID === sharingSession?.id)
			.forEach((device) => {
				deskreenGlobal.connectedDevicesService.disconnectDeviceByID(device.id);
			});

		sharingSession?.denyConnectionForPartner();
		sharingSession?.disconnectByHostMachineUser();
		sharingSession?.destroy();
		sharingSession?.setStatus(SharingSessionStatusEnum.DESTROYED);
		deskreenGlobal.sharingSessionService.sharingSessions.delete(
			sharingSession?.id as string,
		);
		deskreenGlobal.sharingSessionService.waitingForConnectionSharingSession =
			null;
		if (roomID) {
			releaseRoomID(roomID);
		}
	}

	ipcMain.handle(IpcEvents.ResetWaitingForConnectionSharingSession, () => {
		resetWaitingForConnectionSharingSession();
	});

	const hasActiveSharingSession = (): boolean => {
		const { sharingSessions } = getDeskreenGlobal().sharingSessionService;
		return [...sharingSessions.values()].some(
			(session) =>
				session.status === SharingSessionStatusEnum.SHARING ||
				session.status === SharingSessionStatusEnum.CONNECTED,
		);
	};

	const notifyNextPendingDevice = (): void => {
		const nextDevice =
			getDeskreenGlobal().connectedDevicesService.pendingConnectionDevice;
		if (!nextDevice.id) return;
		const targetWindow = mainWindow?.isDestroyed() ? null : mainWindow;
		targetWindow?.webContents.send(
			IpcEvents.SetPendingConnectionDevice,
			nextDevice,
		);
	};

	const removeViewerAvailabilityListener =
		getDeskreenGlobal().connectedDevicesService.addAvailabilityListener(
			(state) => {
				const isAvailable = state === 'available';
				const targetWindow = mainWindow?.isDestroyed() ? null : mainWindow;
				if (targetWindow) {
					targetWindow.webContents.send(
						IpcEvents.ViewerConnectionAvailabilityChanged,
						{
							isAvailable,
						},
					);
				}
				if (isAvailable && !hasActiveSharingSession()) {
					void createWaitingForConnectionSharingSession();
				}
			},
		);

	mainWindow.on('closed', () => {
		removeViewerAvailabilityListener();
	});

	ipcMain.handle(
		IpcEvents.SetSharingType,
		(_, type: 'screen' | 'window' | 'extended') => {
			const sharingSession =
				getDeskreenGlobal().sharingSessionService
					.waitingForConnectionSharingSession;
			if (!sharingSession) return;

			const sharingType =
				type === 'extended'
					? SharingTypeEnum.EXTENDED_DISPLAY
					: type === 'screen'
						? SharingTypeEnum.SCREEN
						: SharingTypeEnum.APP;

			sharingSession.setSharingType(sharingType);
		},
	);

	ipcMain.handle(IpcEvents.GetVirtualDisplaySupport, () => {
		return getDeskreenGlobal().virtualDisplayService.getSupportInfo();
	});

	ipcMain.handle(IpcEvents.InstallVirtualDisplayDriver, () => {
		return getDeskreenGlobal().virtualDisplayService.installWindowsDriver();
	});

	ipcMain.handle(IpcEvents.GetExtendedDisplaySettings, () => {
		return getExtendedDisplaySettings();
	});

	ipcMain.handle(
		IpcEvents.SetExtendedDisplaySettings,
		(
			_,
			settings:
				| {
						frameRate?: unknown;
						bitrateMbps?: unknown;
						resolutionScale?: unknown;
						priority?: unknown;
				  }
				| undefined,
		) => {
			const previous = getExtendedDisplaySettings();
			const next = saveExtendedDisplaySettings(settings);
			const deskreenGlobal = getDeskreenGlobal();

			deskreenGlobal.rendererWebrtcHelpersService.helpers.forEach(
				(helperWindow) => {
					if (!helperWindow.isDestroyed()) {
						helperWindow.webContents.send(
							IpcEvents.ExtendedDisplaySettingsChanged,
							next,
						);
					}
				},
			);

			if (
				previous.frameRate !== next.frameRate ||
				previous.resolutionScale !== next.resolutionScale
			) {
				deskreenGlobal.virtualDisplayService.applySettingsToDisplays();
			}

			return next;
		},
	);

	ipcMain.handle(IpcEvents.GetSharingType, () => {
		const sharingSession =
			getDeskreenGlobal().sharingSessionService
				.waitingForConnectionSharingSession;
		if (!sharingSession) return 'not-set';

		if (sharingSession.sharingType === SharingTypeEnum.EXTENDED_DISPLAY) {
			return 'extended';
		}
		if (sharingSession.sharingType === SharingTypeEnum.SCREEN) {
			return 'screen';
		}
		if (sharingSession.sharingType === SharingTypeEnum.APP) {
			return 'window';
		}
		return 'not-set';
	});

	ipcMain.handle(IpcEvents.SetDeviceConnectedStatus, async () => {
		const deskreenGlobal = getDeskreenGlobal();
		const { connectedDevicesService, sharingSessionService } = deskreenGlobal;
		const pendingDevice = connectedDevicesService.pendingConnectionDevice;

		if (!pendingDevice.id) {
			return { isFirstViewer: false, connected: false };
		}

		const waitingSession =
			sharingSessionService.waitingForConnectionSharingSession;

		if (
			waitingSession !== null &&
			pendingDevice.sharingSessionID === waitingSession.id
		) {
			if (waitingSession.firstViewerDeviceID === '') {
				// The first viewer only opens the source selection flow. The
				// peer is created later, when the host confirms the source.
				waitingSession.firstViewerDeviceID = pendingDevice.id;
				waitingSession.sendUserAllowedToConnect(pendingDevice.id);
				waitingSession.setStatus(SharingSessionStatusEnum.CONNECTED);
				return { isFirstViewer: true, connected: false };
			}

			if (waitingSession.firstViewerDeviceID === pendingDevice.id) {
				// Duplicate approval for the same device, ignore it.
				return { isFirstViewer: true, connected: false };
			}
		}

		const sharingSession = sharingSessionService.sharingSessions.get(
			pendingDevice.sharingSessionID,
		);

		if (!sharingSession) {
			return { isFirstViewer: false, connected: false };
		}

		if (!connectedDevicesService.isSlotAvailable()) {
			sharingSession.denyConnectionForPartner(pendingDevice.id);
			connectedDevicesService.resetPendingConnectionDevice();
			notifyNextPendingDevice();
			return { isFirstViewer: false, connected: false };
		}

		try {
			connectedDevicesService.addDevice(pendingDevice);
		} catch (error) {
			console.error('failed to add connected viewer', error);
			sharingSession.denyConnectionForPartner(pendingDevice.id);
			connectedDevicesService.resetPendingConnectionDevice();
			notifyNextPendingDevice();
			return { isFirstViewer: false, connected: false };
		}

		connectedDevicesService.resetPendingConnectionDevice();
		sharingSession.sendUserAllowedToConnect(pendingDevice.id);

		if (sharingSession.sharingType === SharingTypeEnum.EXTENDED_DISPLAY) {
			try {
				const display =
					await deskreenGlobal.virtualDisplayService.createForDevice(
						pendingDevice,
					);

				if (!connectedDevicesService.getDeviceByID(pendingDevice.id)) {
					deskreenGlobal.virtualDisplayService.destroyForDevice(
						pendingDevice.id,
					);
					return { isFirstViewer: false, connected: false };
				}

				sharingSession.setPartnerDesktopCapturerSourceID(
					pendingDevice.id,
					display.sourceID,
					display.width,
					display.height,
				);
			} catch (error) {
				console.error('failed to create virtual display', error);
				connectedDevicesService.disconnectDeviceByID(pendingDevice.id);
				sharingSession.denyConnectionForPartner(pendingDevice.id);
				notifyNextPendingDevice();
				return {
					isFirstViewer: false,
					connected: false,
					error: String(error),
				};
			}
		}

		sharingSession.callPeer(pendingDevice.id);
		notifyNextPendingDevice();
		return { isFirstViewer: false, connected: true };
	});

	ipcMain.handle(IpcEvents.DenyPendingConnectionDevice, () => {
		const deskreenGlobal = getDeskreenGlobal();
		const { connectedDevicesService, sharingSessionService } = deskreenGlobal;
		const pendingDevice = connectedDevicesService.pendingConnectionDevice;
		const waitingSession =
			sharingSessionService.waitingForConnectionSharingSession;
		const isFirstViewer =
			waitingSession !== null &&
			pendingDevice.id !== '' &&
			waitingSession.firstViewerDeviceID === pendingDevice.id;

		if (pendingDevice.id !== '') {
			sharingSessionService.sharingSessions
				.get(pendingDevice.sharingSessionID)
				?.denyConnectionForPartner(pendingDevice.id);
		}

		connectedDevicesService.resetPendingConnectionDevice();
		notifyNextPendingDevice();
		return { isFirstViewer };
	});

	ipcMain.handle(
		IpcEvents.GetSourceDisplayIDByDesktopCapturerSourceID,
		(_, sourceId) => {
			return getDeskreenGlobal().desktopCapturerSourcesService.getSourceDisplayIDByDisplayCapturerSourceID(
				sourceId,
			);
		},
	);

	ipcMain.handle(
		IpcEvents.DisconnectPeerAndDestroySharingSessionBySessionID,
		(_, sessionId) => {
			const deskreenGlobal = getDeskreenGlobal();
			const sharingSession =
				deskreenGlobal.sharingSessionService.sharingSessions.get(sessionId);

			deskreenGlobal.virtualDisplayService.destroyForSession(sessionId);

			if (sharingSession) {
				deskreenGlobal.connectedDevicesService
					.getDevicesBySharingSessionID(sessionId)
					.forEach((device) => {
						deskreenGlobal.connectedDevicesService.disconnectDeviceByID(
							device.id,
						);
						sharingSession.disconnectByHostMachineUser(device.id);
					});
				sharingSession.setStatus(SharingSessionStatusEnum.DESTROYED);
			}

			sharingSession?.destroy();
			deskreenGlobal.sharingSessionService.sharingSessions.delete(sessionId);
			if (
				deskreenGlobal.sharingSessionService.waitingForConnectionSharingSession
					?.id === sessionId
			) {
				deskreenGlobal.sharingSessionService.waitingForConnectionSharingSession =
					null;
			}
			if (sharingSession) {
				releaseRoomID(sharingSession.roomID);
			}
		},
	);

	ipcMain.handle(
		IpcEvents.GetDesktopCapturerSourceIdBySharingSessionId,
		(_, sessionId) => {
			return getDeskreenGlobal().sharingSessionService.sharingSessions.get(
				sessionId,
			)?.desktopCapturerSourceID;
		},
	);

	ipcMain.handle(IpcEvents.GetConnectedDevices, () => {
		return getDeskreenGlobal().connectedDevicesService.getDevices();
	});

	ipcMain.handle(IpcEvents.GetViewerConnectionAvailability, () => {
		return getDeskreenGlobal().connectedDevicesService.isSlotAvailable();
	});

	ipcMain.handle(IpcEvents.DisconnectDeviceById, (_, id) => {
		const deskreenGlobal = getDeskreenGlobal();
		const {
			connectedDevicesService,
			sharingSessionService,
			virtualDisplayService,
		} = deskreenGlobal;
		const device = connectedDevicesService.getDeviceByID(id);
		const pendingDevice =
			connectedDevicesService.getPendingConnectionDeviceByID(id);

		connectedDevicesService.disconnectDeviceByID(id);

		if (device) {
			sharingSessionService.sharingSessions
				.get(device.sharingSessionID)
				?.disconnectByHostMachineUser(id);
		} else if (pendingDevice) {
			const session = sharingSessionService.sharingSessions.get(
				pendingDevice.sharingSessionID,
			);

			if (
				session &&
				session === sharingSessionService.waitingForConnectionSharingSession &&
				session.firstViewerDeviceID === id &&
				connectedDevicesService.getDevicesBySharingSessionID(session.id)
					.length === 0
			) {
				// The first viewer left before the host started sharing, so the
				// next viewer must go through the first-viewer flow again.
				session.firstViewerDeviceID = '';
				session.setStatus(SharingSessionStatusEnum.NOT_CONNECTED);
			}

			session?.denyConnectionForPartner(id);
		}

		virtualDisplayService.destroyForDevice(id);
		notifyNextPendingDevice();
	});

	ipcMain.handle(IpcEvents.DisconnectAllDevices, () => {
		getDeskreenGlobal().connectedDevicesService.disconnectAllDevices();
	});

	ipcMain.handle(IpcEvents.AppLanguageChanged, (_, newLang) => {
		if (store.has(ElectronStoreKeys.AppLanguage)) {
			store.delete(ElectronStoreKeys.AppLanguage);
		}
		store.set(ElectronStoreKeys.AppLanguage, newLang);
		getDeskreenGlobal().sharingSessionService.sharingSessions.forEach(
			(sharingSession) => {
				sharingSession?.appLanguageChanged();
			},
		);
		i18n.changeLanguage(newLang);
	});

	ipcMain.handle(IpcEvents.GetDesktopCapturerServiceSourcesMap, () => {
		const map =
			getDeskreenGlobal().desktopCapturerSourcesService.getSourcesMap();
		const res = {};

		for (const key of map.keys()) {
			const source = map.get(key);
			// eslint-disable-next-line @typescript-eslint/ban-ts-comment
			// @ts-ignore
			res[key] = {
				source: {
					thumbnail: source?.source.thumbnail?.toDataURL(),
					appIcon: source?.source.appIcon?.toDataURL(),
					name: source?.source.name,
				},
			};
		}
		return res;
	});

	ipcMain.handle(
		IpcEvents.GetDesktopCapturerServiceSourcesByIds,
		(_, ids: string[]) => {
			const map =
				getDeskreenGlobal().desktopCapturerSourcesService.getSourcesMap();
			const res = {};

			ids.forEach((id) => {
				const source = map.get(id);
				if (!source) return;
				// eslint-disable-next-line @typescript-eslint/ban-ts-comment
				// @ts-ignore
				res[id] = {
					source: {
						thumbnail: source?.source.thumbnail?.toDataURL(),
						appIcon: source?.source.appIcon?.toDataURL(),
						name: source?.source.name,
					},
				};
			});
			return res;
		},
	);

	ipcMain.handle(
		IpcEvents.GetWaitingForConnectionSharingSessionSourceId,
		() => {
			return getDeskreenGlobal().sharingSessionService
				.waitingForConnectionSharingSession?.desktopCapturerSourceID;
		},
	);

	async function startSharingOnWaitingForConnectionSharingSession(): Promise<void> {
		const deskreenGlobal = getDeskreenGlobal();
		const {
			connectedDevicesService,
			sharingSessionService,
			virtualDisplayService,
		} = deskreenGlobal;

		const pendingDevice = connectedDevicesService.pendingConnectionDevice;
		if (!pendingDevice.id) {
			return;
		}

		const sharingSession =
			sharingSessionService.waitingForConnectionSharingSession;
		if (sharingSession === null) {
			// Additional viewers are approved directly by
			// SetDeviceConnectedStatus, they do not own a waiting session.
			return;
		}

		if (!connectedDevicesService.isSlotAvailable()) {
			sharingSession.denyConnectionForPartner(pendingDevice.id);
			sharingSession.setStatus(SharingSessionStatusEnum.NOT_CONNECTED);
			sharingSessionService.waitingForConnectionSharingSession = null;
			connectedDevicesService.resetPendingConnectionDevice();
			return;
		}

		try {
			connectedDevicesService.addDevice(pendingDevice);
		} catch (error) {
			console.error('failed to add connected viewer', error);
			sharingSession.setStatus(SharingSessionStatusEnum.ERROR);
			sharingSession.denyConnectionForPartner(pendingDevice.id);
			sharingSessionService.waitingForConnectionSharingSession = null;
			connectedDevicesService.resetPendingConnectionDevice();
			return;
		}

		if (sharingSession.sharingType === SharingTypeEnum.EXTENDED_DISPLAY) {
			try {
				const display =
					await virtualDisplayService.createForDevice(pendingDevice);

				if (!connectedDevicesService.getDeviceByID(pendingDevice.id)) {
					virtualDisplayService.destroyForDevice(pendingDevice.id);
					connectedDevicesService.resetPendingConnectionDevice();
					return;
				}

				sharingSession.desktopCapturerSourceID = display.sourceID;
				sharingSession.setPartnerDesktopCapturerSourceID(
					pendingDevice.id,
					display.sourceID,
					display.width,
					display.height,
				);
			} catch (error) {
				console.error('failed to create virtual display', error);
				connectedDevicesService.disconnectDeviceByID(pendingDevice.id);
				sharingSession.denyConnectionForPartner(pendingDevice.id);
				sharingSession.setStatus(SharingSessionStatusEnum.DESTROYED);
				sharingSession.destroy();
				sharingSessionService.sharingSessions.delete(sharingSession.id);
				sharingSessionService.waitingForConnectionSharingSession = null;
				connectedDevicesService.resetPendingConnectionDevice();
				releaseRoomID(sharingSession.roomID);
				// Do not leave the app without a waiting room when the display
				// could not be created.
				void createWaitingForConnectionSharingSession();
				return;
			}
		}

		sharingSession.callPeer(pendingDevice.id);
		sharingSession.setStatus(SharingSessionStatusEnum.SHARING);
		sharingSessionService.waitingForConnectionSharingSession = null;

		connectedDevicesService.resetPendingConnectionDevice();
		notifyNextPendingDevice();
	}

	ipcMain.handle(
		IpcEvents.StartSharingOnWaitingForConnectionSharingSession,
		async () => {
			await startSharingOnWaitingForConnectionSharingSession();
		},
	);

	ipcMain.handle(IpcEvents.GetPendingConnectionDevice, () => {
		return getDeskreenGlobal().connectedDevicesService.pendingConnectionDevice;
	});

	ipcMain.handle(IpcEvents.GetWaitingForConnectionSharingSessionRoomId, () => {
		const { sharingSessionService } = getDeskreenGlobal();
		const waitingSession =
			sharingSessionService.waitingForConnectionSharingSession;

		if (waitingSession !== null) {
			return waitingSession.roomID;
		}

		const activeSession = [
			...sharingSessionService.sharingSessions.values(),
		].find(
			(session) =>
				session.status === SharingSessionStatusEnum.SHARING ||
				session.status === SharingSessionStatusEnum.CONNECTED,
		);

		return activeSession?.roomID;
	});

	ipcMain.handle(
		IpcEvents.GetDesktopSharingSourceIds,
		async (_, { isEntireScreenToShareChosen }) => {
			if (isLinuxWaylandSession) {
				return [];
			}
			// ensure sources are up to date at request time
			await getDeskreenGlobal().desktopCapturerSourcesService.refreshDesktopCapturerSources();

			if (isEntireScreenToShareChosen === true) {
				return getDeskreenGlobal()
					.desktopCapturerSourcesService.getScreenSources()
					.map((source) => source.id);
			}
			return getDeskreenGlobal()
				.desktopCapturerSourcesService.getAppWindowSources()
				.map((source) => source.id);
		},
	);

	ipcMain.handle(IpcEvents.SetDesktopCapturerSourceId, (_, id) => {
		getDeskreenGlobal().sharingSessionService.waitingForConnectionSharingSession?.setDesktopCapturerSourceID(
			id,
		);
	});

	ipcMain.handle(IpcEvents.GetIsFirstTimeAppStart, () => {
		if (store.has(ElectronStoreKeys.IsNotFirstTimeAppStart)) {
			return false;
		}
		return true;
	});

	ipcMain.handle(IpcEvents.SetAppStartedOnce, () => {
		if (store.has(ElectronStoreKeys.IsNotFirstTimeAppStart)) {
			store.delete(ElectronStoreKeys.IsNotFirstTimeAppStart);
		}
		store.set(ElectronStoreKeys.IsNotFirstTimeAppStart, 'true');
	});

	ipcMain.handle(IpcEvents.GetAppLanguage, () => {
		if (store.has(ElectronStoreKeys.AppLanguage)) {
			return store.get(ElectronStoreKeys.AppLanguage);
		}
		return 'en';
	});

	ipcMain.handle(IpcEvents.DestroySharingSessionById, (_, id) => {
		const deskreenGlobal = getDeskreenGlobal();
		const { sharingSessionService, connectedDevicesService } = deskreenGlobal;

		deskreenGlobal.virtualDisplayService.destroyForSession(id);

		const sharingSession = sharingSessionService.sharingSessions.get(id);
		const wasActive =
			sharingSession?.status === SharingSessionStatusEnum.SHARING ||
			sharingSession?.status === SharingSessionStatusEnum.CONNECTED;

		// Free capacity for every viewer that belonged to this session.
		connectedDevicesService
			.getDevicesBySharingSessionID(id)
			.forEach((device) => {
				connectedDevicesService.disconnectDeviceByID(device.id);
			});

		connectedDevicesService
			.getPendingConnectionDevices()
			.filter((device) => device.sharingSessionID === id)
			.forEach((device) => {
				connectedDevicesService.disconnectDeviceByID(device.id);
			});

		if (sharingSessionService.waitingForConnectionSharingSession?.id === id) {
			sharingSessionService.waitingForConnectionSharingSession = null;
		}

		sharingSession?.setStatus(SharingSessionStatusEnum.DESTROYED);
		sharingSession?.destroy();
		sharingSessionService.sharingSessions.delete(id);

		// Release the room reservation with the session as the single source of
		// truth. The helper renderer used to do it on its own, but that message
		// could arrive after a new session reused the id.
		if (sharingSession) {
			releaseRoomID(sharingSession.roomID);
		}

		// When an active session closes because the last viewer left, go back
		// to the "waiting for connection" state with a fresh room.
		if (wasActive && mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(IpcEvents.SharingSessionClosed);
		}

		// Always make sure the app has a waiting room again, unless another
		// active session exists (the helper guards both cases). Skip it while
		// the app is shutting down.
		if (mainWindow && !mainWindow.isDestroyed()) {
			void createWaitingForConnectionSharingSession();
		}
	});

	ipcMain.handle(IpcEvents.OpenExternalLink, (_, url: string) => {
		if (typeof url !== 'string') {
			return;
		}
		shell.openExternal(url);
	});

	ipcMain.handle(IpcEvents.WriteTextToClipboard, (_, text) => {
		clipboard.writeText(text);
	});

	ipcMain.handle(IpcEvents.CheckScreenRecordingPermission, () => {
		return checkScreenRecordingPermission();
	});

	ipcMain.handle(IpcEvents.RelaunchApp, () => {
		app.relaunch();
		app.exit(0);
	});

	void createWaitingForConnectionSharingSession();
};
