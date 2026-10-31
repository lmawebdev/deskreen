import { Text } from '@blueprintjs/core';
import { useEffect, useState } from 'react';
import { Col, Row } from 'react-flexbox-grid';
import { useTranslation } from 'react-i18next';
import { Device } from '../../../../common/Device';
import { IpcEvents } from '../../../../common/IpcEvents.enum';
import DeviceInfoCallout from '../DeviceInfoCallout';
import SharingSourcePreviewCard from '../SharingSourcePreviewCard';

interface ConfirmStepProps {
	device: Device | null;
}

export default function ConfirmStep(props: ConfirmStepProps) {
	const { device } = props;
	const [
		waitingForConnectionSharingSessionSourceId,
		setWaitingForConnectionSharingSessionSourceId,
	] = useState<string | undefined>();
	const [isExtendedDisplay, setIsExtendedDisplay] = useState(false);
	const { t } = useTranslation();

	useEffect(() => {
		window.electron.ipcRenderer
			.invoke(IpcEvents.GetSharingType)
			.then((sharingType: string) => {
				setIsExtendedDisplay(sharingType === 'extended');
			})
			.catch((e) => console.error(e));

		window.electron.ipcRenderer
			.invoke(IpcEvents.GetWaitingForConnectionSharingSessionSourceId)
			.then((id) => {
				setWaitingForConnectionSharingSessionSourceId(id);
			})
			.catch((e) => console.error(e));
	}, []);

	const virtualDisplayWidth =
		device && device.deviceScreenWidth > 0 ? device.deviceScreenWidth : 1280;
	const virtualDisplayHeight =
		device && device.deviceScreenHeight > 0 ? device.deviceScreenHeight : 800;

	return (
		<div style={{ width: '80%', marginTop: '50px' }}>
			<Row style={{ marginBottom: '10px' }}>
				<Col xs={12} style={{ textAlign: 'center' }}>
					<Text>{t('check-if-all-is-ok-and-click-confirm')}</Text>
				</Col>
			</Row>
			<Row middle="xs" center="xs">
				<Col xs={5}>
					<DeviceInfoCallout
						deviceType={device?.deviceType}
						deviceIP={device?.deviceIP}
						deviceOS={device?.deviceOS}
						deviceBrowser={device?.deviceBrowser}
						deviceRoomId={device?.deviceRoomId}
					/>
				</Col>
				<Col xs={5}>
					{isExtendedDisplay ? (
						<>
							<Text>
								{t('extended-display-will-be-created', {
									width: virtualDisplayWidth,
									height: virtualDisplayHeight,
								})}
							</Text>
							<Text>{t('extended-display-description')}</Text>
						</>
					) : (
						<>
							<Text>{t('this-screen-source-will-be-seen-by-the-client')}</Text>
							<SharingSourcePreviewCard
								sharingSourceID={waitingForConnectionSharingSessionSourceId}
							/>
						</>
					)}
				</Col>
			</Row>
		</div>
	);
}
