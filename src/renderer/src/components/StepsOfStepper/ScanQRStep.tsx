import { Button, Dialog, Position, Text, Tooltip } from '@blueprintjs/core';
import { createStyles, makeStyles } from '@material-ui/core';
import { QRCodeSVG } from 'qrcode.react';
import React, { useEffect, useMemo, useState } from 'react';
import { Col, Row } from 'react-flexbox-grid';
import { useTranslation } from 'react-i18next';
import { IpcEvents } from '../../../../common/IpcEvents.enum';
import Logo192 from '../../assets/logo192.png';

const useStyles = makeStyles(() =>
	createStyles({
		smallQRCode: {
			height: '100%',
			border: '1px solid',
			borderColor: 'rgba(0,0,0,0.0)',
			padding: '10px',
			borderRadius: '10px',
			margin: '0 auto',
			'&:hover': {
				backgroundColor: 'rgba(0,0,0,0.12)',
				border: '1px solid #8A9BA8',
				cursor: 'zoom-in',
			},
		},
		zoomDialog: {
			width: 'auto !important',
			maxWidth: '92vw',
			padding: '0 !important',
			border: 'none !important',
			background: 'transparent !important',
			boxShadow: 'none !important',
		},
		zoomBody: {
			display: 'flex',
			flexDirection: 'column',
			alignItems: 'center',
			gap: '18px',
		},
		zoomCard: {
			backgroundColor: '#ffffff',
			padding: '18px',
			borderRadius: '24px',
			boxShadow: '0 30px 70px -30px rgba(15, 23, 42, 0.65)',
			lineHeight: 0,
		},
		zoomCaption: {
			marginTop: '12px',
			color: '#64748b',
			fontSize: '13px',
			lineHeight: 1.4,
			textAlign: 'center',
		},
		zoomUrlButton: {
			borderRadius: '999px',
			maxWidth: '92vw',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
			whiteSpace: 'nowrap',
		},
	}),
);

const ScanQRStep: React.FC = () => {
	const { t } = useTranslation();
	const [clientViewerPort, setClientViewerPort] = useState('80'); // Default port, can be changed later
	const classes = useStyles();

	const [isViewerSlotAvailable, setIsViewerSlotAvailable] = useState(true);
	const [roomID, setRoomID] = useState('');
	const [LOCAL_LAN_IP, setLocalLanIP] = useState('');
	const [isQRCodeMagnified, setIsQRCodeMagnified] = useState(false);
	const [qrZoomSize, setQrZoomSize] = useState(360);

	useEffect(() => {
		if (!isQRCodeMagnified) return;
		const updateSize = (): void => {
			// Keep the enlarged QR inside the window: only the QR grows, never
			// the rest of the app.
			const available = Math.min(
				window.innerWidth * 0.9,
				window.innerHeight * 0.78,
			);
			setQrZoomSize(Math.round(Math.max(220, Math.min(540, available - 80))));
		};
		updateSize();
		window.addEventListener('resize', updateSize);
		return () => window.removeEventListener('resize', updateSize);
	}, [isQRCodeMagnified]);

	useEffect(() => {
		window.electron.ipcRenderer
			.invoke(IpcEvents.GetPort)
			.then((port) => {
				return setClientViewerPort(port);
			})
			.catch((error) => {
				console.error('Failed to get port:', error);
			});
	}, []);

	useEffect(() => {
		let cancelled = false;

		const handleAvailabilityChange = (
			_: unknown,
			payload: { isAvailable: boolean },
		): void => {
			if (cancelled) return;
			const isAvailable = Boolean(payload?.isAvailable);
			setIsViewerSlotAvailable(isAvailable);
			if (!isAvailable) {
				setRoomID('');
				setIsQRCodeMagnified(false);
			}
		};

		window.electron.ipcRenderer
			.invoke(IpcEvents.GetViewerConnectionAvailability)
			.then((availability) => {
				if (cancelled) return;
				const isAvailable = Boolean(availability);
				setIsViewerSlotAvailable(isAvailable);
				if (!isAvailable) {
					setRoomID('');
					setIsQRCodeMagnified(false);
				}
			})
			.catch((error) => {
				console.error('Failed to get viewer slot availability:', error);
			});

		window.electron.ipcRenderer.on(
			IpcEvents.ViewerConnectionAvailabilityChanged,
			handleAvailabilityChange,
		);

		return () => {
			cancelled = true;
			window.electron.ipcRenderer.removeListener(
				IpcEvents.ViewerConnectionAvailabilityChanged,
				handleAvailabilityChange,
			);
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		const fetchRoomId = async (): Promise<void> => {
			const roomId = await window.electron.ipcRenderer.invoke(
				IpcEvents.GetWaitingForConnectionSharingSessionRoomId,
			);
			if (cancelled) return;
			if (
				typeof roomId === 'string' &&
				roomId !== '' &&
				isViewerSlotAvailable
			) {
				setRoomID(roomId);
			} else {
				setRoomID('');
			}
		};

		const fetchLocalIp = async (): Promise<void> => {
			const gotIP =
				await window.electron.ipcRenderer.invoke('get-local-lan-ip');
			if (!cancelled && gotIP) {
				setLocalLanIP(gotIP);
			}
		};

		void fetchRoomId();
		void fetchLocalIp();
		const roomInterval = setInterval(() => {
			void fetchRoomId();
		}, 1000);
		const ipInterval = setInterval(() => {
			void fetchLocalIp();
		}, 1000);

		return () => {
			cancelled = true;
			clearInterval(roomInterval);
			clearInterval(ipInterval);
		};
	}, [isViewerSlotAvailable]);

	const portString = useMemo(() => {
		return `:${clientViewerPort}`;
	}, [clientViewerPort]);
	const roomPath = useMemo(() => {
		return roomID !== '' ? `/${roomID}` : '';
	}, [roomID]);
	const shareUrl = useMemo(() => {
		if (!isViewerSlotAvailable) return '';
		if (LOCAL_LAN_IP === '') return '';
		if (roomPath === '') return '';
		return `http://${LOCAL_LAN_IP}${portString}${roomPath}`;
	}, [LOCAL_LAN_IP, portString, roomPath, isViewerSlotAvailable]);
	const isQrInteractive = shareUrl !== '';
	const connectionLimitTooltip = t('connection-limit-reached-tooltip');
	const qrTooltipContent = isQrInteractive
		? t('click-to-make-bigger')
		: connectionLimitTooltip;
	const copyTooltipContent = isQrInteractive
		? t('click-to-copy')
		: connectionLimitTooltip;

	return (
		<>
			<div style={{ textAlign: 'center' }}>
				<Text>
					<span
						style={{
							backgroundColor: 'rgba(37, 99, 235, 0.1)',
							color: '#1d4ed8',
							fontWeight: 700,
							padding: '4px 12px',
							border: '1px solid rgba(37, 99, 235, 0.18)',
							borderRadius: '999px',
							display: 'inline-block',
						}}
					>
						{t(
							'make-sure-your-computer-and-screen-viewing-device-are-connected-to-same-wi-fi',
						)}
					</span>
				</Text>
			</div>
			<div>
				<Row>
					<Col xs={12}>
						<div style={{ textAlign: 'center' }}>
							<Text className="bp3-text">
								{t('scan-the-qr-code-to-connect')}
							</Text>
						</div>
						<div
							style={{
								display: 'flex',
								flexDirection: 'column',
								alignItems: 'center',
								justifyContent: 'center',
								height: '100%',
								marginBottom: '16px',
							}}
						>
							<Tooltip content={qrTooltipContent} position={Position.LEFT}>
								<span>
									{isQrInteractive ? (
										<Button
											id="magnify-qr-code-button"
											className={classes.smallQRCode}
											onClick={() => {
												if (!isQrInteractive) return;
												setIsQRCodeMagnified(true);
											}}
											disabled={!isQrInteractive}
										>
											<QRCodeSVG
												value={shareUrl}
												level="H"
												bgColor="rgba(0,0,0,0.0)"
												fgColor="#000000"
												imageSettings={{
													// src: `http://127.0.0.1${portString}/logo192.png`,
													src: Logo192,
													width: 40,
													height: 40,
													excavate: true,
												}}
											/>
										</Button>
									) : (
										<div
											className={classes.smallQRCode}
											style={{ cursor: 'not-allowed' }}
										>
											<img
												src={Logo192}
												alt={t('deskreen-logo')}
												width={64}
												height={64}
											/>
										</div>
									)}
								</span>
							</Tooltip>
						</div>
					</Col>
				</Row>
			</div>
			<Row
				style={{
					marginBottom: '10px',
					display: 'flex',
					flexDirection: 'row',
					alignItems: 'center',
					justifyContent: 'center',
					textAlign: 'center',
				}}
			>
				<Text className="bp3-text-muted">
					{isQrInteractive
						? t(
								'enter-the-following-address-in-browser-address-bar-on-any-device',
							)
						: t('one-viewing-client-is-connected-already')}
				</Text>
			</Row>

			<Row
				style={{
					display: 'flex',
					flexDirection: 'row',
					justifyContent: 'center',
				}}
			>
				<Tooltip content={copyTooltipContent} position={Position.TOP}>
					<span>
						<Button
							intent={isQrInteractive ? 'primary' : 'none'}
							icon="duplicate"
							style={{ borderRadius: '100px' }}
							disabled={!isQrInteractive}
							onClick={() => {
								if (!isQrInteractive) return;
								window.electron.ipcRenderer.invoke(
									IpcEvents.WriteTextToClipboard,
									shareUrl,
								);
							}}
						>
							{isQrInteractive ? shareUrl : t('viewing-client-connected-label')}
						</Button>
					</span>
				</Tooltip>
			</Row>

			<Dialog
				className={classes.zoomDialog}
				isOpen={isQrInteractive && isQRCodeMagnified}
				onClose={() => setIsQRCodeMagnified(false)}
				canEscapeKeyClose
				canOutsideClickClose
				transitionDuration={0}
			>
				<div className={classes.zoomBody}>
					<div className={classes.zoomCard}>
						<QRCodeSVG
							value={shareUrl}
							level="H"
							size={qrZoomSize}
							marginSize={2}
							bgColor="#ffffff"
							fgColor="#0f172a"
							imageSettings={{
								src: Logo192,
								width: Math.round(qrZoomSize * 0.18),
								height: Math.round(qrZoomSize * 0.18),
								excavate: true,
							}}
						/>
						<div className={classes.zoomCaption}>
							{t('scan-the-qr-code-to-connect')}
						</div>
					</div>
					<Button
						className={classes.zoomUrlButton}
						intent="primary"
						icon="duplicate"
						onClick={() => {
							window.electron.ipcRenderer.invoke(
								IpcEvents.WriteTextToClipboard,
								shareUrl,
							);
						}}
					>
						{shareUrl}
					</Button>
				</div>
			</Dialog>
		</>
	);
};

export default ScanQRStep;
