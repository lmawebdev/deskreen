/*
 * original JS code from darkwire.io
 * translated to typescript for Deskreen app
 * by Pavlo (Paul) Buidenkov
 * */

import crypto from 'crypto';
import detectPort from 'detect-port';
import http from 'http';
import cors from 'kcors';
import Koa from 'koa';
import Router from 'koa-router';
import koaSend from 'koa-send';
import koaStatic from 'koa-static';
import { Server } from 'socket.io';
import config from '../common/config';
import SharingSessionStatusEnum from '../features/SharingSessionService/SharingSessionStatusEnum';
import { getDeskreenGlobal } from '../main/helpers/getDeskreenGlobal';
import getMyLocalIpV4 from '../main/helpers/getMyLocalIpV4';
import Logger from '../main/utils/LoggerWithFilePrefix';
import DarkwireSocket from './darkwireSocket';
import { getClientViewerDistPath } from './getClientViewerDistPath';
import SocketsIPService from './socketsIPService';
import startPollForInactiveRooms from './startPollForInactiveRooms';
import getStore from './store';
import socketIOServerStore from './store/socketIOServerStore';

const { hostname, primaryPort, backupPort } = config;

const getRoomIdHash = (id: string): string => {
	return crypto.createHash('sha256').update(id).digest('hex');
};

/**
 * A room belongs to the app while a live sharing session owns it. This is the
 * authoritative check: the reserved-room set alone can get out of sync (for
 * example when the main renderer reloads), and that used to reject the host
 * helper with NOT_ALLOWED, leaving a link that never connects.
 */
const isRoomOwnedByLiveSession = (roomId: string): boolean => {
	const { sharingSessionService } = getDeskreenGlobal();
	if (
		sharingSessionService.waitingForConnectionSharingSession?.roomID === roomId
	) {
		return true;
	}
	return [...sharingSessionService.sharingSessions.values()].some(
		(session) =>
			session.roomID === roomId &&
			session.status !== SharingSessionStatusEnum.DESTROYED &&
			session.status !== SharingSessionStatusEnum.ERROR,
	);
};

const ioHandleOnConnection = (socket): void => {
	const { roomId } = socket.handshake.query;
	const store = getStore();

	setTimeout(async () => {
		const taken = getDeskreenGlobal().roomIDService.isRoomIDTaken(roomId);
		const ownedByLiveSession = isRoomOwnedByLiveSession(roomId);
		if (!taken && !ownedByLiveSession) {
			socket.emit('NOT_ALLOWED');
			setTimeout(() => {
				socket.disconnect(true);
			}, 1000);
			return;
		}
		const roomIdHash = getRoomIdHash(roomId);

		const storedRoom = await store.get('rooms', roomIdHash);
		const parsedRoom =
			typeof storedRoom === 'string' ? JSON.parse(storedRoom) : {};

		new DarkwireSocket({
			roomIdOriginal: roomId,
			roomId: roomIdHash,
			socket,
			room: parsedRoom as Room,
		});
		// }
	}, 500); // timeout 500 millisecond for throttling malicious connections
};

function setStaticFileHeaders(
	ctx: Koa.ParameterizedContext<Koa.DefaultState, Koa.DefaultContext>,
): void {
	ctx.set({
		'strict-transport-security': 'max-age=31536000',
		'X-Frame-Options': 'deny',
		'X-XSS-Protection': '1; mode=block',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'no-referrer',
		'Feature-Policy':
			"geolocation 'none'; vr 'none'; payment 'none'; microphone 'none'",
		// 'Cache-Control': 'max-age=0', // make browser get fresh files and make new connection when client connected
	});
}

class DeskreenSignalingServer {
	log = new Logger(__filename);

	server = {} as unknown as http.Server;

	hostname: string;

	primaryPort: number;

	backupPort: number;

	port: number;

	app: Koa | undefined;

	clientDistDirectory: string;

	constructor() {
		const localIp = getMyLocalIpV4();
		this.hostname = localIp || String(hostname);
		this.primaryPort = parseInt(primaryPort as unknown as string, 10);
		this.backupPort = parseInt(backupPort as unknown as string, 10);

		this.port = this.primaryPort;
		this.clientDistDirectory = getClientViewerDistPath();

		if (!this.clientDistDirectory) {
			this.log.error(
				'Client viewer bundle is missing. Remote connections will fail.',
			);
		}

		this.init();
	}

	init(): void {
		this.app = new Koa();
		const router = new Router();

		this.app.use(cors());
		this.app.use(router.routes());

		const clientDistDirectory = this.clientDistDirectory;

		if (clientDistDirectory) {
			this.app.use(async (ctx, next) => {
				setStaticFileHeaders(ctx);
				await koaStatic(clientDistDirectory)(ctx, next);
			});

			this.app.use(async (ctx) => {
				setStaticFileHeaders(ctx);
				await koaSend(ctx, 'index.html', { root: clientDistDirectory });
			});
		} else {
			this.app.use(async (ctx) => {
				ctx.body = { ready: true };
			});
		}

		const protocol = http;

		this.server = protocol.createServer(this.app.callback());
		const io = new Server(this.server, {
			pingInterval: 20000,
			pingTimeout: 5000,
			serveClient: false,
			// In dev the renderer and the client-viewer run on Vite ports while
			// the signaling server stays on 3131, so cross-origin polling needs
			// CORS. In production the viewer is served from this same origin.
			cors: { origin: '*' },
		});

		io.sockets.on('connection', (socket) => {
			const socketId = socket.id;

			const clientIp = socket.request.socket.remoteAddress;
			SocketsIPService.setIPOfSocketID(socketId, clientIp || '');
		});

		io.on('connection', (socket) => {
			ioHandleOnConnection(socket);
		});

		socketIOServerStore.setServer(io);
	}

	async start(): Promise<http.Server> {
		startPollForInactiveRooms();
		this.server = await this.callListenOnHttpServer();
		return this.server;
	}

	listenCallback() {
		return () => {
			this.log.info(
				`Deskreen CE signaling server is online at port ${this.port}`,
			);
			this.log.info(
				`🌐 Server available at http://${this.hostname}:${this.port}`,
			);
		};
	}

	async callListenOnHttpServer(): Promise<http.Server> {
		return new Promise<http.Server>((resolve, reject) => {
			const tryListen = (port: number): void => {
				// Remove any previous error listeners
				this.server.removeAllListeners('error');

				// Set up error handler
				this.server.once('error', async (error: NodeJS.ErrnoException) => {
					if (
						error.code === 'EADDRINUSE' &&
						(port === this.primaryPort || port === this.backupPort)
					) {
						// Primary port is already in use, try backup
						this.log.error(`Port ${port} is already in use`);
						this.log.warn(
							`Port ${primaryPort} is in use. Trying backup port ${backupPort}...`,
						);

						try {
							const detectedBackupPort = await detectPort(backupPort);

							if (backupPort === detectedBackupPort) {
								this.log.info(`Backup port ${backupPort} is available.`);
								this.port = backupPort;
								tryListen(backupPort);
							} else {
								const errorMsg = `Both primary port ${primaryPort} and backup port ${backupPort} are in use`;
								this.log.error(`Error: ${errorMsg}`);
								// reject(new Error(errorMsg));
								this.port = await detectPort();
								tryListen(this.port);
							}
						} catch (err) {
							this.log.error(
								'An unexpected error occurred while detecting ports:',
								err,
							);
							reject(err);
						}
					} else {
						// Some other error or backup port is also in use
						this.log.error(`Failed to start server on port ${port}:`, error);
						reject(error);
					}
				});

				// Attempt to listen on all interfaces (0.0.0.0) to allow both local and local network access
				this.server.listen(port, '0.0.0.0', () => {
					this.listenCallback()();
					resolve(this.server);
				});
			};

			// Start with the primary port
			tryListen(this.port);
		});
	}

	stop(): void {
		this.server.close();
	}
}

export const signalingServer = new DeskreenSignalingServer();
