import { Device } from '../../common/Device';
import { MAX_VIEWERS } from '../../common/maxViewers';

export const nullDevice: Device = {
	id: '',
	sharingSessionID: '',
	deviceOS: '',
	deviceType: '',
	deviceIP: '',
	deviceBrowser: '',
	deviceScreenWidth: -1,
	deviceScreenHeight: -1,
	deviceRoomId: '',
};

type ViewerConnectionAvailability = 'available' | 'occupied';

/**
 * Keeps track of every viewer connected to the host, and of the viewers that
 * are waiting for the host user to approve their connection.
 *
 * The service allows up to MAX_VIEWERS simultaneous viewers. Pending devices are
 * kept in a FIFO queue so two viewers connecting at the same time are approved
 * one after the other instead of overwriting each other's notification.
 */
export class ConnectedDevicesService {
	private readonly devices = new Map<string, Device>();

	private pendingConnectionDevices: Device[] = [];

	private readonly availabilityListeners = new Set<
		(state: ViewerConnectionAvailability) => void
	>();

	get pendingConnectionDevice(): Device {
		return this.pendingConnectionDevices[0] ?? nullDevice;
	}

	getPendingConnectionDevices(): Device[] {
		return this.pendingConnectionDevices.map((device) => ({ ...device }));
	}

	resetPendingConnectionDevice(): void {
		this.pendingConnectionDevices.shift();
	}

	setPendingConnectionDevice(device: Device): void {
		if (!device.id) return;
		if (this.devices.has(device.id)) return;
		if (
			this.pendingConnectionDevices.some((pending) => pending.id === device.id)
		)
			return;
		this.pendingConnectionDevices.push({ ...device });
	}

	getDevices(): Device[] {
		return [...this.devices.values()].map((device) => ({ ...device }));
	}

	getDeviceByID(deviceID: string): Device | undefined {
		const device = this.devices.get(deviceID);
		return device ? { ...device } : undefined;
	}

	getDevicesBySharingSessionID(sharingSessionID: string): Device[] {
		return this.getDevices().filter(
			(device) => device.sharingSessionID === sharingSessionID,
		);
	}

	isSlotAvailable(): boolean {
		return this.devices.size < MAX_VIEWERS;
	}

	addAvailabilityListener(
		listener: (state: ViewerConnectionAvailability) => void,
	): () => void {
		this.availabilityListeners.add(listener);
		listener(this.getAvailabilityState());
		return () => {
			this.availabilityListeners.delete(listener);
		};
	}

	disconnectAllDevices(): void {
		this.devices.clear();
		this.pendingConnectionDevices = [];
		this.notifyAvailabilityListeners();
	}

	disconnectDeviceByID(deviceIDToRemove: string): void {
		const hadPendingDevice = this.pendingConnectionDevices.some(
			(device) => device.id === deviceIDToRemove,
		);

		if (hadPendingDevice) {
			this.pendingConnectionDevices = this.pendingConnectionDevices.filter(
				(device) => device.id !== deviceIDToRemove,
			);
		}

		const hadConnectedDevice = this.devices.delete(deviceIDToRemove);

		if (hadPendingDevice || hadConnectedDevice) {
			this.notifyAvailabilityListeners();
		}
	}

	getPendingConnectionDeviceByID(deviceID: string): Device | undefined {
		const device = this.pendingConnectionDevices.find(
			(pending) => pending.id === deviceID,
		);
		return device ? { ...device } : undefined;
	}

	addDevice(device: Device): void {
		if (this.devices.has(device.id)) return;
		if (!this.isSlotAvailable()) {
			throw new Error('maximum number of connected viewers was reached');
		}
		this.devices.set(device.id, { ...device });
		this.notifyAvailabilityListeners();
	}

	private getAvailabilityState(): ViewerConnectionAvailability {
		return this.isSlotAvailable() ? 'available' : 'occupied';
	}

	private notifyAvailabilityListeners(): void {
		const state = this.getAvailabilityState();
		this.availabilityListeners.forEach((listener) => {
			try {
				listener(state);
			} catch (error) {
				console.error('connected devices availability listener failed', error);
			}
		});
	}
}
