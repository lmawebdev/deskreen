import { Callout, Card, H3, Text, Tooltip, Position } from '@blueprintjs/core';
import { useTranslation } from 'react-i18next';
import { LIGHT_UI_BACKGROUND } from '../../constants/styleConstants';

interface MyDeviceDetailsCardProps {
	deviceDetails: DeviceDetails;
}

function MyDeviceInfoCard(props: MyDeviceDetailsCardProps) {
	const { t } = useTranslation();

	const { deviceDetails } = props;
	const { myIP, myOS, myDeviceType, myBrowser, myRoomId } = deviceDetails;

	return (
		<Card
			elevation={3}
			style={{
				backgroundColor: LIGHT_UI_BACKGROUND,
				marginBottom: '30px',
			}}
		>
			<H3>{`${t('My Device Info')}:`}</H3>
			<Callout>
				<Text>{`${t('Device Type')}: ${myDeviceType}`}</Text>
				<Tooltip
					content={t(
						'Your Device IP should match with Device IP in alert popup appeared on your computer, where Deskreen-CE is running',
					)}
					position={Position.TOP}
				>
					<div
						className="device-ip-pill"
						style={{
							fontWeight: 800,
							backgroundColor: 'rgba(34, 211, 238, 0.14)',
							border: '1px solid rgba(34, 211, 238, 0.3)',
							padding: '4px 10px',
							borderRadius: '999px',
						}}
					>
						<Text>{`${t('Device IP')}: ${myIP}`}</Text>
					</div>
				</Tooltip>
				<Text>{`${t('Device Browser')}: ${myBrowser}`}</Text>
				<Text>{`${t('Device OS')}: ${myOS}`}</Text>
				<Text>{`${t('My Current Connection ID')}: ${myRoomId}`}</Text>
			</Callout>
			<Text className="bp3-text-muted">
				{t(
					'These details should match with the ones that you see in alert popup on computer screen, where Deskreen-CE is running',
				)}
			</Text>
		</Card>
	);
}

export default MyDeviceInfoCard;
