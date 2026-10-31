import { useTranslation } from 'react-i18next';
import MyDeviceInfoCard from '../../components/MyDeviceInfoCard';
import type { TFunction } from 'i18next';
import { Button, H3 } from '@blueprintjs/core';
import ConnectingIndicator from '../../components/ConnectingIndicator';
import DeskreenLogo from '../../images/deskreen_logo_128x128.png';

interface ConnectionPropmptsProps {
	myDeviceDetails: DeviceDetails;
	isShownTextPrompt: boolean;
	promptStep: number;
	connectionIconType: ConnectionIconType;
	isShownSpinnerIcon: boolean;
	spinnerIconType: LoadingSharingIconType;
}

function getPromptContent(t: TFunction, step: number) {
	switch (step) {
		case 1:
			return (
				<H3>
					{
						t(
							'Waiting for user to click ALLOW button on screen sharing device...',
						) as string
					}
				</H3>
			);
		case 2:
			return <H3>{t('Connected!') as string}</H3>;
		case 3:
			return (
				<H3>
					{
						t(
							'Waiting for user to select source to share from screen sharing device...',
						) as string
					}
				</H3>
			);
		default:
			return <H3>{`${t('Error occurred')} :(`}</H3>;
	}
}

function ConnectionPropmpts(props: ConnectionPropmptsProps) {
	const {
		myDeviceDetails,
		promptStep,
		connectionIconType,
		isShownSpinnerIcon,
		spinnerIconType,
	} = props;

	const { t } = useTranslation();

	const handleReinitiateConnection = () => {
		window.location.reload();
	};

	return (
		<div className="viewer-connection-shell">
			<div className="viewer-connection-card">
				<img
					src={DeskreenLogo}
					alt="Deskreen Logo"
					className="viewer-brand-logo"
				/>
				<H3 className="viewer-brand-title">Deskreen Viewer</H3>
				<MyDeviceInfoCard deviceDetails={myDeviceDetails} />
				<div className="viewer-prompt-text">
					{getPromptContent(t, promptStep)}
				</div>
				<Button
					className="rounded-pill-button viewer-reconnect-btn"
					onClick={handleReinitiateConnection}
				>
					{t('re-initiate-connection') as string}
				</Button>
			</div>
			<ConnectingIndicator
				currentStep={promptStep}
				connectionIconType={connectionIconType}
				isShownSelectingSharingIcon={isShownSpinnerIcon}
				selectingSharingIconType={spinnerIconType}
			/>
		</div>
	);
}

export default ConnectionPropmpts;
