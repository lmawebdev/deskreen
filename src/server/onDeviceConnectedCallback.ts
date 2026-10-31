import { Device } from '../common/Device';
import { IpcEvents } from '../common/IpcEvents.enum';
import { deskreenApp } from '../main';
import { getDeskreenGlobal } from '../main/helpers/getDeskreenGlobal';

export function onDeviceConnectedCallback(device: Device): void {
	const deskreenGlobal = getDeskreenGlobal();
	const { connectedDevicesService, sharingSessionService } = deskreenGlobal;

	if (!connectedDevicesService.isSlotAvailable()) {
		sharingSessionService.sharingSessions
			.get(device.sharingSessionID)
			?.denyConnectionForPartner(device.id);
		return;
	}

	connectedDevicesService.setPendingConnectionDevice(device);

	// Only the head of the FIFO queue is shown to the host. After each
	// approval/denial the next one is notified by the main process.
	const pendingDevice = connectedDevicesService.pendingConnectionDevice;
	if (pendingDevice.id !== device.id) return;

	deskreenApp.mainWindow?.webContents.send(
		IpcEvents.SetPendingConnectionDevice,
		device,
	);
}
