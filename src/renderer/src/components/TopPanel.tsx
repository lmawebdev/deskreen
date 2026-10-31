import React from 'react';
import { Button, Icon, Position, Tooltip } from '@blueprintjs/core';
import { createStyles, makeStyles } from '@material-ui/core/styles';
import SettingsOverlay from './SettingsOverlay/SettingsOverlay';
import ConnectedDevicesListDrawer from './ConnectedDevicesListDrawer';
import { useTranslation } from 'react-i18next';
import { IpcEvents } from '../../../common/IpcEvents.enum';

const useStyles = makeStyles(() =>
	createStyles({
		topPanelRoot: {
			display: 'flex',
			flexDirection: 'column',
			alignItems: 'center',
			minHeight: '56px',
			paddingTop: '0px',
			marginBottom: '4px',
			position: 'relative',
			gap: '12px',
		},
		donateButtonRoot: {
			display: 'flex',
			justifyContent: 'center',
			width: '100%',
			marginTop: '4px',
		},
		logoWithAppName: { margin: '0 auto' },
		appNameHeader: {
			margin: '0 auto',
			paddingTop: '5px',
			fontFamily: 'Lexend Peta',
			fontSize: '20px',
			color: '#e2791b',
			cursor: 'default !important',
		},
		donateButton: {
			borderRadius: '100px',
			padding: '0',
			height: '40px',
			background:
				'linear-gradient(135deg, hsl(258, 90%, 66%) 0%, hsl(210, 96%, 62%) 30%, hsl(192, 94%, 44%) 70%, hsl(28, 96%, 58%) 100%)',
			border: 'none',
			boxShadow:
				'0 4px 12px rgba(102, 51, 204, 0.4), 0 2px 4px rgba(102, 51, 204, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
			transition: 'all 0.2s ease',
			'&:hover': {
				transform: 'translateY(-1px)',
				boxShadow:
					'0 6px 16px rgba(102, 51, 204, 0.5), 0 3px 6px rgba(102, 51, 204, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.3)',
			},
		},
		donateButtonContent: {
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			height: '100%',
			padding: '0 16px',
			gap: '8px',
		},
		donateButtonIcon: {
			width: '20px',
			height: '20px',
			display: 'block',
			verticalAlign: 'middle',
			flexShrink: 0,
			filter: 'brightness(1.1) drop-shadow(0 1px 2px rgba(0, 0, 0, 0.2))',
		},
		donateButtonLabel: {
			display: 'flex',
			alignItems: 'center',
			lineHeight: '1',
			fontSize: '14px',
			fontWeight: 600,
			color: '#ffffff',
			textShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
		},
		topPanelControlButtonsRoot: {
			display: 'flex',
			alignItems: 'center',
			gap: '12px',
		},
		topPanelControlsWrapper: {
			position: 'absolute',
			right: '72px',
			top: '15px',
			display: 'flex',
			flexDirection: 'column',
			alignItems: 'flex-end',
			gap: '6px',
		},
		topPanelControlButton: {
			width: '40px',
			height: '40px',
			borderRadius: '50px',
			cursor: 'default !important',
		},
		topPanelControlButtonMargin: {
			cursor: 'default !important',
			position: 'relative',
		},
		updateBadge: {
			borderRadius: '12px',
			cursor: 'pointer',
			boxShadow: 'none',
		},
		topPanelIconOfControlButton: {
			cursor: 'default !important',
		},
		connectedDevicesBadge: {
			position: 'absolute',
			top: '-4px',
			right: '-4px',
			backgroundColor: '#ff3b30',
			color: '#ffffff',
			borderRadius: '10px',
			minWidth: '20px',
			height: '20px',
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			fontSize: '12px',
			fontWeight: 600,
			padding: '0 6px',
			boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)',
			zIndex: 10,
			lineHeight: '1',
		},
	}),
);

interface Props {
	handleReset: () => void;
}

export default function TopPanel({ handleReset }: Props): React.ReactElement {
	const { t } = useTranslation();
	const classes = useStyles();

	const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);
	const [isConnectedDevicesDrawerOpen, setIsConnectedDevicesDrawerOpen] =
		React.useState(false);
	const [connectedDevicesCount, setConnectedDevicesCount] = React.useState(0);

	const handleSettingsOpen = React.useCallback(() => {
		setIsSettingsOpen(true);
	}, []);

	const handleSettingsClose = React.useCallback(() => {
		setIsSettingsOpen(false);
	}, []);

	const handleToggleConnectedDevicesListDrawer = React.useCallback(() => {
		setIsConnectedDevicesDrawerOpen(!isConnectedDevicesDrawerOpen);
	}, [isConnectedDevicesDrawerOpen]);

	React.useEffect(() => {
		const fetchConnectedDevicesCount = async (): Promise<void> => {
			try {
				const devices = await window.electron.ipcRenderer.invoke(
					IpcEvents.GetConnectedDevices,
				);
				if (Array.isArray(devices)) {
					setConnectedDevicesCount(devices.length);
				}
			} catch (e) {
				console.error(e);
			}
		};

		fetchConnectedDevicesCount();

		const connectedDevicesInterval = setInterval(
			fetchConnectedDevicesCount,
			2000,
		);

		return () => {
			clearInterval(connectedDevicesInterval);
		};
	}, []);

	const renderConnectedDevicesListButton = (
		<div className={classes.topPanelControlButtonMargin}>
			<Tooltip content={t('connected-devices')} position={Position.BOTTOM}>
				<Button
					id="top-panel-connected-devices-list-button"
					intent="primary"
					className={classes.topPanelControlButton}
					onClick={handleToggleConnectedDevicesListDrawer}
				>
					<Icon
						className={classes.topPanelIconOfControlButton}
						icon="th-list"
						size={20}
					/>
				</Button>
			</Tooltip>
			{connectedDevicesCount > 0 && (
				<span className={classes.connectedDevicesBadge}>
					{connectedDevicesCount}
				</span>
			)}
		</div>
	);

	const renderSettingsButton = (
		<div className={classes.topPanelControlButtonMargin}>
			<Tooltip content={t('settings')} position={Position.BOTTOM}>
				<Button
					id="top-panel-settings-button"
					onClick={handleSettingsOpen}
					className={classes.topPanelControlButton}
				>
					<Icon
						className={classes.topPanelIconOfControlButton}
						icon="cog"
						size={22}
						color="#0f172a"
					/>
				</Button>
			</Tooltip>
		</div>
	);

	return (
		<>
			<div className={classes.topPanelRoot}>
				<div className={classes.topPanelControlsWrapper}>
					<div className={classes.topPanelControlButtonsRoot}>
						{renderConnectedDevicesListButton}
						{renderSettingsButton}
					</div>
				</div>
			</div>
			{isSettingsOpen ? (
				<SettingsOverlay
					isSettingsOpen={isSettingsOpen}
					handleClose={handleSettingsClose}
				/>
			) : (
				<></>
			)}
			{isConnectedDevicesDrawerOpen ? (
				<ConnectedDevicesListDrawer
					isOpen={isConnectedDevicesDrawerOpen}
					handleToggle={handleToggleConnectedDevicesListDrawer}
					handleReset={handleReset}
				/>
			) : (
				<></>
			)}
		</>
	);
}
