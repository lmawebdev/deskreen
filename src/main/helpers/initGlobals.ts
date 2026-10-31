import { app } from 'electron';
import { ConnectedDevicesService } from '../../features/ConnectedDevicesService';
import DesktopCapturerSources from '../../features/DesktopCapturerSourcesService';
import DesktopCapturerSourcesService from '../../features/DesktopCapturerSourcesService';
import RendererWebrtcHelpersService from '../../features/PeerConnectionHelperRendererService';
import SharingSessionService from '../../features/SharingSessionService';
import VirtualDisplayService from '../../features/VirtualDisplayService';
import RoomIDService from '../../server/RoomIDService';

export interface DeskreenGlobal {
	appPath: string;
	rendererWebrtcHelpersService: RendererWebrtcHelpersService;
	roomIDService: RoomIDService;
	connectedDevicesService: ConnectedDevicesService;
	sharingSessionService: SharingSessionService;
	desktopCapturerSourcesService: DesktopCapturerSourcesService;
	virtualDisplayService: VirtualDisplayService;
	latestAppVersion: string;
	currentAppVersion: string;
	cliLocalIp?: string;
}

export const initGlobals = (appPath: string, cliLocalIp?: string) => {
	const deskreenGlobal: DeskreenGlobal = global as unknown as DeskreenGlobal;

	deskreenGlobal.appPath = appPath;
	deskreenGlobal.rendererWebrtcHelpersService =
		new RendererWebrtcHelpersService(appPath);
	deskreenGlobal.roomIDService = new RoomIDService();
	deskreenGlobal.connectedDevicesService = new ConnectedDevicesService();
	deskreenGlobal.sharingSessionService = new SharingSessionService(
		deskreenGlobal.roomIDService,
		deskreenGlobal.connectedDevicesService,
		deskreenGlobal.rendererWebrtcHelpersService,
	);
	deskreenGlobal.desktopCapturerSourcesService = new DesktopCapturerSources();
	deskreenGlobal.virtualDisplayService = new VirtualDisplayService(
		deskreenGlobal.desktopCapturerSourcesService,
	);
	deskreenGlobal.latestAppVersion = '';
	deskreenGlobal.currentAppVersion = app.getVersion();
	deskreenGlobal.cliLocalIp = cliLocalIp;
};
