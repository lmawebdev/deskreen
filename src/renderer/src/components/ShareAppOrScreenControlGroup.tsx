import { Button, Icon, Text } from '@blueprintjs/core';
import { createStyles, makeStyles } from '@material-ui/core/styles';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IpcEvents } from '../../../common/IpcEvents.enum';
import ChooseAppOrScreenOverlay from './StepsOfStepper/ChooseAppOrScreenOverlay/ChooseAppOrScreenOverlay';

interface ShareAppOrScreenControlGroupProps {
	handleNextEntireScreen: () => void;
	handleNextApplicationWindow: () => void;
	handleNextExtendedDisplay: () => void;
}

const useStyles = makeStyles(() =>
	createStyles({
		controlGroupRoot: {
			display: 'flex',
			justifyContent: 'center',
			alignItems: 'stretch',
			gap: '12px',
			flexWrap: 'wrap',
		},
		shareOptionButton: {
			height: '180px',
			width: '180px',
			borderRadius: '20px !important',
			color: 'white',
			fontSize: '18px',
			textAlign: 'center',
			display: 'flex',
			flexDirection: 'column',
			justifyContent: 'center',
			alignItems: 'center',
		},
		shareExtendedDisplayButton: {
			backgroundColor: '#7c5cff !important',
			'&:hover': {
				backgroundColor: '#6b4be6 !important',
			},
		},
		shareOptionIcon: { marginBottom: '16px' },
	}),
);

export default function ShareAppOrScreenControlGroup(
	props: ShareAppOrScreenControlGroupProps,
) {
	const {
		handleNextEntireScreen,
		handleNextApplicationWindow,
		handleNextExtendedDisplay,
	} = props;
	const classes = useStyles();
	const { t } = useTranslation();

	const [isChooseAppOrScreenOverlayOpen, setChooseAppOrScreenOverlayOpen] =
		useState(false);

	const [isEntireScreenToShareChosen, setEntireScreenToShareChosen] =
		useState(false);

	const [isWaylandSession, setIsWaylandSession] = useState(false);

	useEffect(() => {
		let cancelled = false;

		window.electron.ipcRenderer
			.invoke(IpcEvents.GetIsLinuxWaylandSession)
			.then((value: boolean) => {
				if (!cancelled) {
					setIsWaylandSession(Boolean(value));
				}
			})
			.catch((error: unknown) => {
				console.error('failed to detect session environment', error);
			});

		return () => {
			cancelled = true;
		};
	}, []);

	const handleOpenChooseAppOrScreenOverlay = useCallback(() => {
		setChooseAppOrScreenOverlayOpen(true);
	}, []);

	const handleCloseChooseAppOrScreenOverlay = useCallback(() => {
		setChooseAppOrScreenOverlayOpen(false);
	}, []);

	const handleWaylandShare = useCallback(
		async (mode: 'screen' | 'window') => {
			try {
				const sourceId: string | null =
					await window.electron.ipcRenderer.invoke(
						IpcEvents.RequestDesktopCapturerPortalSource,
						{ mode },
					);
				if (!sourceId) {
					return;
				}
				await window.electron.ipcRenderer.invoke(
					IpcEvents.SetDesktopCapturerSourceId,
					sourceId,
				);
				if (mode === 'screen') {
					handleNextEntireScreen();
				} else {
					handleNextApplicationWindow();
				}
			} catch (error) {
				console.error(
					'failed to acquire desktop capture source via portal',
					error,
				);
			}
		},
		[handleNextApplicationWindow, handleNextEntireScreen],
	);

	const handleChooseAppOverlayOpen = useCallback(() => {
		if (isWaylandSession) {
			void handleWaylandShare('window');
			return;
		}
		setEntireScreenToShareChosen(false);
		handleOpenChooseAppOrScreenOverlay();
	}, [
		handleOpenChooseAppOrScreenOverlay,
		handleWaylandShare,
		isWaylandSession,
	]);

	const handleChooseEntireScreenOverlayOpen = useCallback(() => {
		if (isWaylandSession) {
			void handleWaylandShare('screen');
			return;
		}
		setEntireScreenToShareChosen(true);
		handleOpenChooseAppOrScreenOverlay();
	}, [
		handleOpenChooseAppOrScreenOverlay,
		handleWaylandShare,
		isWaylandSession,
	]);

	return (
		<>
			<div
				id="share-screen-or-app-btn-group"
				className={classes.controlGroupRoot}
			>
				<Button
					className={classes.shareOptionButton}
					intent="primary"
					onClick={handleChooseEntireScreenOverlayOpen}
				>
					<Icon
						className={classes.shareOptionIcon}
						icon="desktop"
						size={80}
						color="white"
					/>
					<Text className="bp3-running-text">{t('entire-screen')}</Text>
				</Button>
				<Button
					className={classes.shareOptionButton}
					intent="primary"
					onClick={handleChooseAppOverlayOpen}
				>
					<Icon
						className={classes.shareOptionIcon}
						icon="application"
						size={80}
						color="white"
					/>
					<Text className="bp3-running-text">{t('application-window')}</Text>
				</Button>
				<Button
					className={`${classes.shareOptionButton} ${classes.shareExtendedDisplayButton}`}
					onClick={handleNextExtendedDisplay}
				>
					<Icon
						className={classes.shareOptionIcon}
						icon="duplicate"
						size={80}
						color="white"
					/>
					<Text className="bp3-running-text">{t('extended-display')}</Text>
				</Button>
			</div>
			<ChooseAppOrScreenOverlay
				isEntireScreenToShareChosen={isEntireScreenToShareChosen}
				isChooseAppOrScreenOverlayOpen={isChooseAppOrScreenOverlayOpen}
				handleClose={handleCloseChooseAppOrScreenOverlay}
				handleNextEntireScreen={handleNextEntireScreen}
				handleNextApplicationWindow={handleNextApplicationWindow}
				isWaylandSession={isWaylandSession}
			/>
		</>
	);
}
