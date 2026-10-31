import { Socket } from 'socket.io-client';
import { connectSocket } from '../../../../common/connectSocket';
import DesktopCapturerSourceType from '../../../../common/DesktopCapturerSourceType';
import { Device } from '../../../../common/Device';
import getAppLanguage from '../../../../common/getAppLanguage';
import { IpcEvents } from '../../../../common/IpcEvents.enum';
import {
	DEFAULT_EXTENDED_DISPLAY_SETTINGS,
	type ExtendedDisplaySettings,
	normalizeExtendedDisplayBitrate,
	normalizeExtendedDisplayFrameRate,
	normalizeExtendedDisplayPriority,
	normalizeExtendedDisplayResolutionScale,
} from '../../../../common/ExtendedDisplaySettings';
import { LocalPeerUser } from '../../../../common/LocalPeerUser';
import type { SendEncryptedMessagePayload } from '../../../../common/SendEncryptedMessagePayload';
import { handleRecieveEncryptedMessage } from '../../utils/handleRecieveEncryptedMessage';
import { isTestMode } from '../../../../common/runtimeEnv';
import { prepare as prepareMessage } from '../../utils/message';
import createDesktopCapturerStream from './createDesktopCapturerStream';
import getDesktopSourceStreamBySourceID from './getDesktopSourceStreamBySourceID';
import handleCreatePeer from './handleCreatePeer';
import handleSelfDestroy from './handleSelfDestroy';
import setDisplaySizeFromLocalStream from './handleSetDisplaySizeFromLocalStream';
import handleSocket from './handleSocket';

type DisplaySize = { width: number; height: number };

type SimplePeerInstance = InstanceType<typeof import('simple-peer')>;

export interface PartnerPeerUser {
	username: string;
	socketId?: string;
	isOwner?: boolean;
}

export interface HostPartnerConnection {
	username: string;
	socketId?: string;
	deviceID: string;
	deviceDetails: Device | null;
	peer: SimplePeerInstance | null;
	signals: unknown[];
	isCallStarted: boolean;
	hasStream: boolean;
	/** Stream object used as the sender-map key by simple-peer. */
	stream: MediaStream | null;
	/** Video track currently being sent to this viewer. */
	currentTrack: MediaStreamTrack | null;
	/** Extended-display mode: per-partner capture source and stream. */
	desktopCapturerSourceID: string;
	localStream: MediaStream | null;
	displayWidth: number;
	displayHeight: number;
	isReplacingTrack: boolean;
	streamPromise: Promise<void> | null;
}

export default class PeerConnection {
	sharingSessionID: string;
	roomID: string;
	socket: Socket;
	user: LocalPeerUser;
	partners = new Map<string, HostPartnerConnection>();
	desktopCapturerSourceID: string;
	localStream: MediaStream | null = null;
	hasStartedSharing = false;
	hasJoinedRoom = false;
	isExtendedDisplayMode = false;
	isDestroyed = false;
	isReplacingSharedTrack = false;
	private readonly senderStatsStarted = new WeakSet<HostPartnerConnection>();
	onDeviceConnectedCallback: (device: Device) => void;
	displayID: string;
	sourceDisplaySize: DisplaySize | undefined;
	beforeunloadHandler: (() => void) | null = null;

	constructor(
		roomID: string,
		sharingSessionID: string,
		user: LocalPeerUser,
		port: string,
	) {
		this.sharingSessionID = sharingSessionID;
		this.roomID = encodeURI(roomID);
		this.socket = connectSocket(port, this.roomID);
		this.user = user;
		this.desktopCapturerSourceID = '';
		this.displayID = '';
		this.sourceDisplaySize = undefined;
		this.onDeviceConnectedCallback = () => {
			// noop until UI layer registers callback
		};

		handleSocket(this);

		this.beforeunloadHandler = () => {
			this.socket.emit('USER_DISCONNECT');
		};
		window.addEventListener('beforeunload', this.beforeunloadHandler);

		window.electron.ipcRenderer.on(
			IpcEvents.ExtendedDisplaySettingsChanged,
			this.handleExtendedDisplaySettingsChanged,
		);
	}

	private readonly handleExtendedDisplaySettingsChanged = (
		_event: unknown,
		settings: ExtendedDisplaySettings,
	): void => {
		for (const partner of this.partners.values()) {
			void this.configurePeerForHighQuality(partner, settings);
		}
	};

	notifyClientWithNewLanguage(): void {
		setTimeout(async () => {
			const value = await getAppLanguage();
			for (const partner of this.partners.values()) {
				await this.sendEncryptedMessage(
					{
						type: 'APP_LANGUAGE',
						payload: {
							value,
						},
					},
					partner.username,
				);
			}
		}, 1000);
	}

	ensurePartner(username: string): HostPartnerConnection {
		let partner = this.partners.get(username);
		if (!partner) {
			partner = {
				username,
				deviceID: '',
				deviceDetails: null,
				peer: null,
				signals: [],
				isCallStarted: false,
				hasStream: false,
				stream: null,
				currentTrack: null,
				desktopCapturerSourceID: '',
				localStream: null,
				displayWidth: 0,
				displayHeight: 0,
				isReplacingTrack: false,
				streamPromise: null,
			};
			this.partners.set(username, partner);
		}
		return partner;
	}

	getPartnerByUsername(username: string): HostPartnerConnection | undefined {
		return this.partners.get(username);
	}

	getPartnerByDeviceID(deviceID: string): HostPartnerConnection | undefined {
		if (!deviceID) return undefined;
		for (const partner of this.partners.values()) {
			if (partner.deviceID === deviceID) return partner;
		}
		return undefined;
	}

	removePartnersNotIn(usernames: Set<string>): void {
		for (const username of [...this.partners.keys()]) {
			if (!usernames.has(username)) {
				this.destroyPartner(username, true);
			}
		}
	}

	destroyPartner(username: string, notifyMain = true): void {
		const partner = this.partners.get(username);
		if (!partner) return;
		this.partners.delete(username);

		if (partner.peer) {
			try {
				partner.peer.removeAllListeners();
				partner.peer.destroy();
			} catch (error) {
				console.error('Error destroying peer:', error);
			}
			partner.peer = null;
		}

		// Extended-display streams belong to one viewer; stop them here.
		if (partner.localStream) {
			partner.localStream.getTracks().forEach((track) => track.stop());
			partner.localStream = null;
		}

		partner.signals = [];
		const deviceID = partner.deviceID;
		partner.deviceID = '';
		partner.deviceDetails = null;

		if (notifyMain && deviceID) {
			void window.electron.ipcRenderer.invoke(
				IpcEvents.DisconnectDeviceById,
				deviceID,
			);
		}
	}

	destroyAllPartners(notifyMain = false): void {
		for (const username of [...this.partners.keys()]) {
			this.destroyPartner(username, notifyMain);
		}
	}

	handlePartnerPeerClosed(username: string, peer: SimplePeerInstance): void {
		const partner = this.partners.get(username);
		if (!partner || partner.peer !== peer) return;

		this.destroyPartner(username, true);

		// The server will also notify us with USER_EXIT, but if this was the
		// last viewer the sharing session must close right away.
		if (this.hasStartedSharing && this.partners.size === 0) {
			this.selfDestroy();
		}
	}

	setExtendedDisplayMode(enabled: boolean): void {
		if (this.isExtendedDisplayMode === enabled) return;
		this.isExtendedDisplayMode = enabled;
		window.electron.ipcRenderer.send('virtual-display-error', {
			event: 'sharing-mode',
			extended: enabled,
		});

		if (enabled) {
			// The virtual display is captured per viewer. Stop any mirror
			// capture that was selected before switching modes.
			this.desktopCapturerSourceID = '';
			this.stopLocalStream();
		}
	}

	getStreamForPartner(partner: HostPartnerConnection): MediaStream | null {
		return this.isExtendedDisplayMode ? partner.localStream : this.localStream;
	}

	async setPartnerDesktopCapturerSourceID(
		deviceID: string,
		sourceID: string,
		displayWidth?: number,
		displayHeight?: number,
	): Promise<void> {
		const partner = this.getPartnerByDeviceID(deviceID);
		if (!partner) return;

		// Receiving a per-partner source is itself proof that this helper is in
		// extended-display mode. Do not depend on a previous IPC arriving.
		this.setExtendedDisplayMode(true);
		partner.desktopCapturerSourceID = sourceID;
		partner.displayWidth = displayWidth ?? 0;
		partner.displayHeight = displayHeight ?? 0;

		window.electron.ipcRenderer.send('virtual-display-error', {
			event: 'partner-source',
			deviceID,
			sourceID,
			displayWidth,
			displayHeight,
		});

		const capture = (async (): Promise<void> => {
			// Constrain the capture to the virtual display size. Without
			// dimensions Chromium picks a default (often 1920px wide) and the
			// track aspect no longer matches the monitor.
			const frameRate = (await this.getExtendedDisplaySettings()).frameRate;
			const stream = await getDesktopSourceStreamBySourceID(
				sourceID,
				partner.displayWidth || undefined,
				partner.displayHeight || undefined,
				1,
				1,
				Math.min(15, frameRate),
				frameRate,
			);
			await this.applyPartnerStream(partner, stream);
		})();

		partner.streamPromise = capture;

		try {
			await capture;
		} catch (error) {
			console.error(
				`Failed to capture virtual display for viewer ${deviceID}`,
				error,
			);
			window.electron.ipcRenderer.send('virtual-display-error', {
				deviceID,
				message: String(error),
			});
		} finally {
			if (partner.streamPromise === capture) {
				partner.streamPromise = null;
			}
		}
	}

	private async applyPartnerStream(
		partner: HostPartnerConnection,
		newStream: MediaStream,
	): Promise<void> {
		const newTrack = newStream.getVideoTracks()[0];
		if (!newTrack) {
			newStream.getTracks().forEach((track) => track.stop());
			return;
		}

		// Screen content must keep text/detail sharp. Without a content hint
		// the encoder may prioritize motion and blur small text.
		newTrack.contentHint = 'text';

		const oldStream = partner.localStream;
		const oldTrack = partner.currentTrack;
		partner.localStream = newStream;

		const settings = newTrack.getSettings();
		window.electron.ipcRenderer.send('virtual-display-error', {
			event: 'capture-ready',
			deviceID: partner.deviceID,
			width: settings.width,
			height: settings.height,
			hasPeer: Boolean(partner.peer),
			callStarted: partner.isCallStarted,
		});

		if (partner.peer) {
			if (partner.hasStream && partner.stream && oldTrack) {
				try {
					partner.peer.replaceTrack(oldTrack, newTrack, partner.stream);
					partner.currentTrack = newTrack;
				} catch (error) {
					console.error(
						`Failed to replace virtual display track for viewer ${partner.username}`,
						error,
					);
				}
			} else {
				try {
					partner.peer.addStream(newStream);
					partner.hasStream = true;
					partner.stream = newStream;
					partner.currentTrack = newTrack;
				} catch (error) {
					console.error(
						`Failed to add virtual display stream for viewer ${partner.username}`,
						error,
					);
				}
			}
		} else {
			partner.hasStream = true;
			partner.stream = newStream;
			partner.currentTrack = newTrack;

			// The viewer was already approved and called; the peer is created
			// as soon as its virtual display stream exists.
			if (partner.isCallStarted) {
				await this.createPeerForPartner(partner);
			}
		}

		if (oldStream && oldStream !== newStream) {
			oldStream.getTracks().forEach((track) => {
				if (track.id !== newTrack.id) track.stop();
			});
		}

		void this.configurePeerForHighQuality(partner);
	}

	/**
	 * Extended displays are captured at their native (often portrait) size.
	 * Without explicit encoder parameters Chromium may downscale the track and
	 * the viewer ends up seeing a blurry upscaled image. Ask the sender to keep
	 * the native resolution and allow a high bitrate on the LAN.
	 */
	private async getExtendedDisplaySettings(): Promise<ExtendedDisplaySettings> {
		try {
			const raw = (await window.electron.ipcRenderer.invoke(
				IpcEvents.GetExtendedDisplaySettings,
			)) as Partial<ExtendedDisplaySettings> | undefined;

			return {
				frameRate: normalizeExtendedDisplayFrameRate(raw?.frameRate),
				bitrateMbps: normalizeExtendedDisplayBitrate(raw?.bitrateMbps),
				resolutionScale: normalizeExtendedDisplayResolutionScale(
					raw?.resolutionScale,
				),
				priority: normalizeExtendedDisplayPriority(raw?.priority),
			};
		} catch (error) {
			console.error('failed to read extended display settings', error);
			return { ...DEFAULT_EXTENDED_DISPLAY_SETTINGS };
		}
	}

	private startSenderStats(partner: HostPartnerConnection): void {
		const peer = partner.peer as unknown as
			| { _pc?: RTCPeerConnection }
			| null;
		const pc = peer?._pc;
		if (!pc) return;

		let remaining = 6;
		const timer = setInterval(async () => {
			try {
				const stats = await pc.getStats();
				stats.forEach((report) => {
					const outbound = report as RTCOutboundRtpStreamStats & {
						kind?: string;
					};

					if (outbound.type !== 'outbound-rtp' || outbound.kind !== 'video') {
						return;
					}

					window.electron.ipcRenderer.send('virtual-display-error', {
						event: 'sender-stats',
						deviceID: partner.deviceID,
						frameWidth: outbound.frameWidth,
						frameHeight: outbound.frameHeight,
						framesPerSecond: outbound.framesPerSecond,
						qualityLimitationReason: outbound.qualityLimitationReason,
						qualityLimitationResolutionChanges:
							outbound.qualityLimitationResolutionChanges,
					});
				});
			} catch {
				// stats are best-effort diagnostics
			}

			remaining -= 1;
			if (remaining <= 0) clearInterval(timer);
		}, 3000);
	}

	async configurePeerForHighQuality(
		partner: HostPartnerConnection,
		settingsOverride?: ExtendedDisplaySettings,
	): Promise<void> {
		const peer = partner.peer as unknown as
			| { _pc?: RTCPeerConnection }
			| null;
		const pc = peer?._pc;
		if (!pc) return;

		const settings =
			settingsOverride ?? (await this.getExtendedDisplaySettings());
		const frameRate = settings.frameRate;
		const contentHint =
			settings.priority === 'quality'
				? 'text'
				: settings.priority === 'latency'
					? 'motion'
					: 'detail';
		const degradationPreference =
			settings.priority === 'quality'
				? 'maintain-resolution'
				: settings.priority === 'latency'
					? 'maintain-framerate'
					: 'balanced';

		for (const track of partner.localStream?.getVideoTracks() ??
			[]) {
			track.contentHint = contentHint;
		}

		const apply = async (): Promise<boolean> => {
			const sender = pc
				.getSenders()
				.find((candidate) => candidate.track?.kind === 'video');
			if (!sender) return false;

			try {
				const params = sender.getParameters();
				if (!params.encodings || params.encodings.length === 0) {
					params.encodings = [{}];
				}

				params.encodings[0].maxBitrate =
					settings.bitrateMbps * 1_000_000;
				params.encodings[0].maxFramerate = frameRate;
				params.encodings[0].scaleResolutionDownBy = 1;
				params.degradationPreference = degradationPreference;
				await sender.setParameters(params);

				window.electron.ipcRenderer.send('virtual-display-error', {
					event: 'sender-configured',
					deviceID: partner.deviceID,
					maxBitrate: params.encodings[0].maxBitrate,
					maxFramerate: params.encodings[0].maxFramerate,
					scaleResolutionDownBy:
						params.encodings[0].scaleResolutionDownBy,
					degradationPreference: params.degradationPreference,
					contentHint,
				});
				return true;
			} catch (error) {
				console.error('failed to configure the video sender', error);
				return false;
			}
		};

		if (!(await apply())) {
			setTimeout(() => {
				void apply();
			}, 1000);
		}

		setTimeout(() => {
			void apply();
		}, 3000);

		if (!this.senderStatsStarted.has(partner)) {
			this.senderStatsStarted.add(partner);
			this.startSenderStats(partner);
		}
	}

	async replacePartnerVideoTrackWithQuality(
		partner: HostPartnerConnection,
		min: number,
		max: number,
	): Promise<void> {
		if (!partner.desktopCapturerSourceID) return;
		if (partner.isReplacingTrack) return;
		partner.isReplacingTrack = true;
		try {
			const newStream = await getDesktopSourceStreamBySourceID(
				partner.desktopCapturerSourceID,
				partner.displayWidth || undefined,
				partner.displayHeight || undefined,
				min,
				max,
				60,
				60,
			);

			const newTrack = newStream.getVideoTracks()[0];
			const settings = newTrack?.getSettings();
			if (
				settings?.width &&
				settings?.height &&
				(settings.width % 2 !== 0 || settings.height % 2 !== 0)
			) {
				console.warn(
					`Skipping odd-sized video track ${settings.width}x${settings.height}`,
				);
				window.electron.ipcRenderer.send('virtual-display-error', {
					deviceID: partner.deviceID,
					message: `skipping odd-sized track ${settings.width}x${settings.height}`,
				});
				newStream.getTracks().forEach((track) => track.stop());
				return;
			}

			await this.applyPartnerStream(partner, newStream);
		} catch (error) {
			console.error('Failed to change virtual display quality:', error);
		} finally {
			partner.isReplacingTrack = false;
		}
	}

	async setDesktopCapturerSourceID(id: string): Promise<void> {
		if (this.isExtendedDisplayMode) return;
		this.desktopCapturerSourceID = id;
		if (isTestMode()) return;

		// clear old display size when switching sources to ensure new source uses correct dimensions
		this.sourceDisplaySize = undefined;
		this.displayID = '';

		await this.setDisplayIDByDesktopCapturerSourceID();

		await this.handleCreatePeerAfterDesktopCapturerSourceIDWasSet();
	}

	async setDisplayIDByDesktopCapturerSourceID(): Promise<void> {
		if (
			!this.desktopCapturerSourceID.includes(DesktopCapturerSourceType.SCREEN)
		) {
			// clear display size for window sources
			this.sourceDisplaySize = undefined;
			return;
		}

		this.displayID = await window.electron.ipcRenderer.invoke(
			IpcEvents.GetSourceDisplayIDByDesktopCapturerSourceID,
			this.desktopCapturerSourceID,
		);

		if (this.displayID !== '') {
			// await to ensure sourceDisplaySize is set before creating stream
			await this.setDisplaySizeRetreivedFromMainProcess();
		}
	}

	async setDisplaySizeRetreivedFromMainProcess(): Promise<void> {
		const size: DisplaySize | 'undefined' =
			await window.electron.ipcRenderer.invoke(
				'get-display-size-by-display-id',
				this.displayID,
			);
		if (size !== 'undefined') {
			this.sourceDisplaySize = size;
		}
	}

	async handleCreatePeerAfterDesktopCapturerSourceIDWasSet(): Promise<void> {
		if (this.localStream) {
			try {
				const newStream = await getDesktopSourceStreamBySourceID(
					this.desktopCapturerSourceID,
					this.sourceDisplaySize?.width,
					this.sourceDisplaySize?.height,
					0.5,
					1,
				);
				this.applyStreamToAllPartners(newStream);
			} catch (error) {
				console.error('Failed to replace stream track:', error);
				// Keep the previous stream: the source switch failed, but the
				// viewers must not lose their running video.
			}
		} else {
			await createDesktopCapturerStream(this, this.desktopCapturerSourceID);

			// A viewer can be approved before the host selects a source. Its
			// peer already exists without media, so attach the new stream now.
			const stream = this.localStream;
			if (stream) {
				for (const partner of this.partners.values()) {
					if (!partner.peer || partner.hasStream) continue;
					try {
						partner.peer.addStream(stream);
						partner.hasStream = true;
					} catch (error) {
						console.error(
							`Failed to add stream for viewer ${partner.username}`,
							error,
						);
					}
				}
			}
		}

		if (!this.sourceDisplaySize) {
			setDisplaySizeFromLocalStream(this);
		}
	}

	/**
	 * Replaces the shared video track on every connected viewer.
	 * All viewers watch the same capture, so the new stream is used for all.
	 */
	applyStreamToAllPartners(newStream: MediaStream): void {
		const newTrack = newStream.getVideoTracks()[0];
		if (!newTrack) {
			newStream.getTracks().forEach((track) => track.stop());
			return;
		}

		const oldStream = this.localStream;
		this.localStream = newStream;

		for (const partner of this.partners.values()) {
			if (!partner.peer) continue;

			if (!partner.hasStream || !partner.stream || !partner.currentTrack) {
				// The viewer was approved before a source was selected, so its
				// peer still has no media. Adding the stream triggers a
				// renegotiation on the already connected peer.
				try {
					partner.peer.addStream(newStream);
					partner.hasStream = true;
					partner.stream = newStream;
					partner.currentTrack = newTrack;
				} catch (error) {
					console.error(
						`Failed to add stream for viewer ${partner.username}`,
						error,
					);
				}
				continue;
			}

			try {
				// simple-peer keys its sender map by the stream object passed to
				// addStream, not by the latest captured stream.
				partner.peer.replaceTrack(
					partner.currentTrack,
					newTrack,
					partner.stream,
				);
				partner.currentTrack = newTrack;
			} catch (error) {
				console.error(
					`Failed to replace track for viewer ${partner.username}`,
					error,
				);
			}
		}

		if (!oldStream) return;

		// Stop tracks that no viewer is sending anymore. A failed replaceTrack
		// keeps its old track alive so that viewer's video does not freeze.
		const activeTrackIDs = new Set(
			[...this.partners.values()]
				.map((partner) => partner.currentTrack?.id)
				.filter((id): id is string => typeof id === 'string'),
		);

		oldStream.getTracks().forEach((track) => {
			if (track.id !== newTrack.id && !activeTrackIDs.has(track.id)) {
				track.stop();
			}
		});
	}

	async replaceSharedVideoTrackWithQuality(
		min: number,
		max: number,
	): Promise<void> {
		if (this.isReplacingSharedTrack) return;
		this.isReplacingSharedTrack = true;
		try {
			const newStream = await getDesktopSourceStreamBySourceID(
				this.desktopCapturerSourceID,
				this.sourceDisplaySize?.width,
				this.sourceDisplaySize?.height,
				min,
				max,
				60,
				60,
			);
			this.applyStreamToAllPartners(newStream);
		} catch (error) {
			console.error('Failed to change shared video quality:', error);
		} finally {
			this.isReplacingSharedTrack = false;
		}
	}

	stopLocalStream(): void {
		if (!this.localStream) return;
		this.localStream.getTracks().forEach((track) => track.stop());
		this.localStream = null;
	}

	setOnDeviceConnectedCallback(callback: (device: Device) => void): void {
		this.onDeviceConnectedCallback = callback;
	}

	private resolveTargets(deviceID?: string): HostPartnerConnection[] {
		if (deviceID) {
			const partner = this.getPartnerByDeviceID(deviceID);
			return partner ? [partner] : [];
		}
		return [...this.partners.values()];
	}

	sendUserAllowedToConnect(deviceID?: string): void {
		for (const partner of this.resolveTargets(deviceID)) {
			void this.sendEncryptedMessage(
				{
					type: 'ALLOWED_TO_CONNECT',
					payload: {},
				},
				partner.username,
			);
		}
	}

	async denyConnectionForPartner(deviceID?: string): Promise<void> {
		for (const partner of this.resolveTargets(deviceID)) {
			await this.sendEncryptedMessage(
				{
					type: 'DENY_TO_CONNECT',
					payload: {},
				},
				partner.username,
			);
			this.disconnectPartnerSocket(partner);
			this.destroyPartner(partner.username, false);
		}
	}

	async disconnectByHostMachineUser(deviceID?: string): Promise<void> {
		for (const partner of this.resolveTargets(deviceID)) {
			await this.sendEncryptedMessage(
				{
					type: 'DISCONNECT_BY_HOST_MACHINE_USER',
					payload: {},
				},
				partner.username,
			);
			this.disconnectPartnerSocket(partner);
			this.destroyPartner(partner.username, false);
		}

		// Last viewer left: close the sharing session like the single viewer flow.
		if (this.partners.size === 0) {
			this.selfDestroy();
		}
	}

	private disconnectPartnerSocket(partner: HostPartnerConnection): void {
		if (partner.socketId) {
			this.socket.emit('DISCONNECT_SOCKET_BY_SOCKET_ID', partner.socketId);
			return;
		}
		if (partner.deviceDetails?.deviceIP) {
			this.socket.emit('DISCONNECT_SOCKET_BY_DEVICE_IP', {
				ip: partner.deviceDetails.deviceIP,
			});
		}
	}

	selfDestroy(): void {
		if (this.isDestroyed) return;
		this.isDestroyed = true;
		handleSelfDestroy(this);
	}

	emitUserEnter(): void {
		this.socket.emit('USER_ENTER', {
			username: this.user.username,
		});
	}

	async sendEncryptedMessage(
		payload: SendEncryptedMessagePayload,
		targetUsername?: string,
	): Promise<void> {
		if (!this.socket) return;
		if (!this.user) return;
		const msg = await prepareMessage(payload, this.user, targetUsername);
		this.socket.emit('MESSAGE', msg.toSend);
	}

	receiveEncryptedMessage(payload: ReceiveEncryptedMessagePayload): void {
		if (!this.user) return;
		handleRecieveEncryptedMessage(this, payload);
	}

	async callPeer(deviceID?: string): Promise<void> {
		if (isTestMode()) return;

		for (const partner of this.resolveTargets(deviceID)) {
			this.hasStartedSharing = true;
			partner.isCallStarted = true;

			// In extended-display mode the peer must be created only after the
			// virtual display stream is ready, otherwise the first offer has no
			// media and the renegotiation can fail on some browsers.
			if (partner.streamPromise) {
				try {
					await partner.streamPromise;
				} catch {
					// The capture error was already reported.
				}
			}

			await this.createPeerForPartner(partner);

			const pendingSignals = partner.signals;
			partner.signals = [];
			for (const signal of pendingSignals) {
				await this.sendEncryptedMessage(
					{
						type: 'CALL_USER',
						payload: {
							signalData: signal,
						},
					},
					partner.username,
				);
			}
		}
	}

	createPeerForPartner(partner: HostPartnerConnection): Promise<void> {
		return handleCreatePeer(this, partner);
	}
}
