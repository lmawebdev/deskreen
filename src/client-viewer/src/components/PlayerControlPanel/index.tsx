import {
	Alignment,
	Button,
	ButtonGroup,
	Card,
	Classes,
	Divider,
	H3,
	H5,
	HTMLSelect,
	Icon,
	Popover,
	Position,
	Switch,
	Text,
	Tooltip,
} from '@blueprintjs/core';
import React, { useCallback, useEffect, useState } from 'react';
import { Col, Row } from 'react-flexbox-grid';
import { useTranslation } from 'react-i18next';
import screenfull from 'screenfull';
import {
	DEFAULT_EXTENDED_DISPLAY_SETTINGS,
	EXTENDED_DISPLAY_BITRATE_OPTIONS,
	EXTENDED_DISPLAY_RESOLUTION_SCALES,
	type ExtendedDisplaySettings,
} from '../../features/PeerConnection/ExtendedDisplaySettings';
import { ScreenSharingSource } from '../../features/PeerConnection/ScreenSharingSourceEnum';
import {
	VideoQuality,
	type VideoQualityType,
} from '../../features/VideoAutoQualityOptimizer/VideoQualityEnum';
import FullScreenEnter from '../../images/fullscreen_24px.svg';
import FullScreenExit from '../../images/fullscreen_exit-24px.svg';
import { handlePlayerToggleFullscreen } from './handlePlayerToggleFullscreen';
import initScreenfullOnChange from './initScreenfullOnChange';
import './index.css';

const videoQualityButtonStyle: React.CSSProperties = {
	width: '100%',
	display: 'flex',
	justifyContent: 'center',
	alignItems: 'center',
	textAlign: 'center',
};

interface PlayerControlPanelProps {
	onSwitchChangedCallback: (isEnabled: boolean) => void;
	isPlaying: boolean;
	isDefaultPlayerTurnedOn: boolean;
	handleClickFullscreen: () => 'entered' | 'exited' | 'failed';
	handleClickPlayPause: () => void;
	setVideoQuality: (q: VideoQualityType) => void;
	selectedVideoQuality: VideoQualityType;
	screenSharingSourceType: ScreenSharingSourceType;
	onExtendedDisplaySettingsChange: (settings: ExtendedDisplaySettings) => void;
	// toaster: undefined | HTMLDivElement;
}

function PlayerControlPanel(props: PlayerControlPanelProps) {
	const { t } = useTranslation();
	const {
		onSwitchChangedCallback,
		isPlaying,
		isDefaultPlayerTurnedOn,
		handleClickPlayPause,
		handleClickFullscreen,
		selectedVideoQuality,
		setVideoQuality,
		screenSharingSourceType,
		onExtendedDisplaySettingsChange,
	} = props;

	const isFullScreenAPIAvailable = screenfull.isEnabled;

	const [isFullScreenOn, setIsFullScreenOn] = useState(false);
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const [extendedDisplaySettings, setExtendedDisplaySettings] =
		useState<ExtendedDisplaySettings>(DEFAULT_EXTENDED_DISPLAY_SETTINGS);

	useEffect(() => {
		const cleanup = initScreenfullOnChange((isOn) => {
			setIsFullScreenOn(isOn);
			if (!isOn) {
				// Leaving fullscreen closes the floating settings panel.
				setIsSettingsOpen(false);
			}
		});
		return cleanup;
	}, []);

	useEffect(() => {
		if (!isFullScreenOn) return;
		// Minimalist behaviour: the floating panel hides as soon as the window
		// (or the player) loses focus.
		const closeSettings = () => setIsSettingsOpen(false);
		window.addEventListener('blur', closeSettings);
		return () => window.removeEventListener('blur', closeSettings);
	}, [isFullScreenOn]);

	const handleClickFullscreenWhenDefaultPlayerIsOn = useCallback(() => {
		const result = handlePlayerToggleFullscreen();
		if (result === 'failed') {
			console.warn('Unable to toggle fullscreen');
			return result;
		}
		setIsFullScreenOn(result === 'entered');
		return result;
	}, [setIsFullScreenOn]);

	const handlePlayPauseClick = useCallback(() => {
		handleClickPlayPause();
	}, [handleClickPlayPause]);

	const handleVideoQualitySelect = useCallback(
		(quality: VideoQualityType) => {
			setVideoQuality(quality);
		},
		[setVideoQuality],
	);

	const handleExtendedDisplaySettingsChange = useCallback(
		(partial: Partial<ExtendedDisplaySettings>): void => {
			const next = { ...extendedDisplaySettings, ...partial };
			setExtendedDisplaySettings(next);
			onExtendedDisplaySettingsChange(next);
		},
		[extendedDisplaySettings, onExtendedDisplaySettingsChange],
	);

	const handleDefaultPlayerToggle = useCallback(() => {
		const nextState = !isDefaultPlayerTurnedOn;
		onSwitchChangedCallback(nextState);
	}, [isDefaultPlayerTurnedOn, onSwitchChangedCallback]);

	const handleFullscreenClick = useCallback(() => {
		const result = isDefaultPlayerTurnedOn
			? handleClickFullscreenWhenDefaultPlayerIsOn()
			: handleClickFullscreen();
		if (result === 'failed') {
			return;
		}
	}, [
		handleClickFullscreen,
		handleClickFullscreenWhenDefaultPlayerIsOn,
		isDefaultPlayerTurnedOn,
	]);

	const settingsContent = (
		<div
			style={{
				maxHeight: '60vh',
				overflowY: 'auto',
				padding: '8px',
			}}
		>
			<H5>{`${t('Video Settings')}:`}</H5>
			<Divider />
			<Row
				style={{
					justifyContent: 'center',
				}}
			>
				<Tooltip
					content={t('flip-the-screen-is-pro-version-only')}
					position={Position.TOP}
				>
					<span
						style={{
							display: 'block',
							width: '100%',
							textAlign: 'center',
						}}
					>
						<Button
							icon="key-tab"
							minimal
							style={videoQualityButtonStyle}
							disabled={true}
						>
							{t('Flip')}
						</Button>
					</span>
				</Tooltip>
			</Row>
			<Divider />
			{Object.values(VideoQuality).map((q: VideoQualityType) => {
				return (
					<Row key={q}>
						<Button
							minimal
							active={selectedVideoQuality === q}
							style={videoQualityButtonStyle}
							disabled={
								screenSharingSourceType === ScreenSharingSource.WINDOW ||
								screenSharingSourceType === ScreenSharingSource.EXTENDED
							}
							onClick={() => {
								handleVideoQualitySelect(q);
							}}
						>
							{q}
						</Button>
					</Row>
				);
			})}
			{screenSharingSourceType === ScreenSharingSource.EXTENDED ? (
				<>
					<Divider />
					<H5>{t('extended-display-quality')}</H5>
					<Row style={{ marginBottom: '8px' }}>
						<Text style={{ flex: 1 }}>{t('extended-display-fps')}</Text>
						<HTMLSelect
							value={extendedDisplaySettings.frameRate}
							onChange={(event) => {
								handleExtendedDisplaySettingsChange({
									frameRate: Number(
										event.currentTarget.value,
									) as ExtendedDisplaySettings['frameRate'],
								});
							}}
							options={[
								{ value: 30, label: '30 fps' },
								{ value: 60, label: '60 fps' },
								{ value: 120, label: '120 fps' },
							]}
						/>
					</Row>
					<Row style={{ marginBottom: '8px' }}>
						<Text style={{ flex: 1 }}>{t('extended-display-bitrate')}</Text>
						<HTMLSelect
							value={extendedDisplaySettings.bitrateMbps}
							onChange={(event) => {
								handleExtendedDisplaySettingsChange({
									bitrateMbps: Number(event.currentTarget.value),
								});
							}}
							options={EXTENDED_DISPLAY_BITRATE_OPTIONS.map((bitrate) => ({
								value: bitrate,
								label: `${bitrate} Mbps`,
							}))}
						/>
					</Row>
					<Row style={{ marginBottom: '8px' }}>
						<Text style={{ flex: 1 }}>{t('extended-display-resolution')}</Text>
						<HTMLSelect
							value={extendedDisplaySettings.resolutionScale}
							onChange={(event) => {
								handleExtendedDisplaySettingsChange({
									resolutionScale: Number(
										event.currentTarget.value,
									) as ExtendedDisplaySettings['resolutionScale'],
								});
							}}
							options={EXTENDED_DISPLAY_RESOLUTION_SCALES.map((scale) => ({
								value: scale,
								label: `${scale}x`,
							}))}
						/>
					</Row>
					<Row style={{ marginBottom: '8px' }}>
						<Text style={{ flex: 1 }}>{t('extended-display-priority')}</Text>
						<HTMLSelect
							value={extendedDisplaySettings.priority}
							onChange={(event) => {
								handleExtendedDisplaySettingsChange({
									priority: event.currentTarget
										.value as ExtendedDisplaySettings['priority'],
								});
							}}
							options={[
								{
									value: 'quality',
									label: t('extended-display-priority-quality'),
								},
								{
									value: 'balanced',
									label: t('extended-display-priority-balanced'),
								},
								{
									value: 'latency',
									label: t('extended-display-priority-latency'),
								},
							]}
						/>
					</Row>
					<Text className="bp3-text-muted" style={{ fontSize: '12px' }}>
						{t('extended-display-client-quality-note')}
					</Text>
				</>
			) : null}
		</div>
	);

	// In fullscreen only a minimal floating control is shown: the whole panel
	// would cover the shared screen. The settings popover is rendered inline
	// (no portal), because portaled content is not visible inside a
	// fullscreen element.
	if (isFullScreenOn) {
		const settingsLabel = t('Click to Open Video Settings');
		const exitLabel = t('Click to Exit Full Screen Mode');
		return (
			<div className="viewer-fullscreen-controls">
				<Popover
					content={settingsContent}
					position={Position.BOTTOM_LEFT}
					usePortal={false}
					isOpen={isSettingsOpen}
					onInteraction={(nextOpenState: boolean) => {
						setIsSettingsOpen(nextOpenState);
					}}
					popoverClassName="viewer-fullscreen-popover"
				>
					<Tooltip
						content={settingsLabel}
						position={Position.RIGHT}
						usePortal={false}
					>
						<Button
							className="viewer-fullscreen-control"
							active={isSettingsOpen}
							aria-label={settingsLabel}
							icon={<Icon icon="cog" size={18} color="#e2e8f0" />}
						/>
					</Tooltip>
				</Popover>
				<Tooltip
					content={exitLabel}
					position={Position.RIGHT}
					usePortal={false}
				>
					<Button
						className="viewer-fullscreen-control"
						aria-label={exitLabel}
						onClick={handleFullscreenClick}
					>
						<img
							src={FullScreenExit}
							width={16}
							height={16}
							className="viewer-fullscreen-exit-icon"
							alt="exit-fullscreen-toggle"
						/>
					</Button>
				</Tooltip>
			</div>
		);
	}

	return (
		<Card elevation={4} className="viewer-control-panel">
			<Row between="xs" middle="xs">
				<Col xs={12} md={3}>
					<Row middle="xs" start="xs">
						<Col xs>
							<Row middle="xs">
								<img
									src="/img/logo512.png"
									alt="logo"
									style={{ height: '56px', marginRight: '12px' }}
								/>
								<H3 style={{ margin: 0, letterSpacing: '-0.02em' }}>
									Deskreen Viewer
								</H3>
							</Row>
						</Col>
					</Row>
				</Col>
				<Col xs={12} md={5}>
					<Row center="xs" style={{ height: '42px' }}>
						<ButtonGroup
							style={{
								borderRadius: '20px',
								backgroundColor: '#137CBD',
								height: '42px',
							}}
						>
							<Tooltip
								content={
									isPlaying
										? t('Click to Pause Video')
										: t('Click to Play Video')
								}
								position={Position.BOTTOM}
							>
								<Button
									minimal
									onClick={handlePlayPauseClick}
									style={{
										color: 'white',
										backgroundColor: !isPlaying
											? 'rgba(255, 255, 255, 0.2)'
											: 'transparent',
										boxShadow: !isPlaying
											? '0 0 20px rgba(19, 124, 189, 0.8), 0 0 40px rgba(19, 124, 189, 0.6)'
											: 'none',
										transition: 'all 0.3s ease-in-out',
										border: 'none',
										outline: 'none',
										boxSizing: 'border-box',
										padding: '0 20px',
										borderRadius: '20px 0 0 20px',
										width: '120px',
										minWidth: '120px',
										maxWidth: '120px',
									}}
									className={
										!isPlaying
											? 'play-pause-button play-pause-button-glow'
											: 'play-pause-button'
									}
								>
									<span
										style={{
											display: 'flex',
											alignItems: 'center',
											gap: '6px',
										}}
									>
										<Icon icon={isPlaying ? 'pause' : 'play'} color="white" />
										<Text
											className="bp3-text-large play-pause-text"
											style={{ color: 'white' }}
										>
											{isPlaying ? t('Pause') : t('Play')}
										</Text>
									</span>
								</Button>
							</Tooltip>
							<Popover
								content={settingsContent}
								position={Position.BOTTOM}
								popoverClassName={Classes.POPOVER_CONTENT_SIZING}
							>
								<Tooltip
									content={t('Click to Open Video Settings')}
									position={Position.BOTTOM}
								>
									<Button
										minimal
										style={{
											color: 'white',
											outline: 'none',
											boxShadow: 'none',
											borderRadius: '0',
											padding: '0 20px',
										}}
										className="settings-button-separator"
									>
										<Icon icon="cog" color="white" />
									</Button>
								</Tooltip>
							</Popover>
							<Tooltip
								content={t('Click to Enter Full Screen Mode')}
								position={Position.BOTTOM}
							>
								<Button
									minimal
									onClick={handleFullscreenClick}
									style={{
										color: 'white',
										border: 'none',
										outline: 'none',
										boxShadow: 'none',
										borderRadius: '0 20px 20px 0',
										padding: '0 20px',
									}}
								>
									<img
										src={isFullScreenOn ? FullScreenExit : FullScreenEnter}
										width={16}
										height={16}
										style={{
											transform: 'scale(1.5) translateY(1px)',
											filter:
												'invert(100%) sepia(100%) saturate(0%) hue-rotate(127deg) brightness(107%) contrast(102%)',
										}}
										alt="fullscreen-toggle"
									/>
								</Button>
							</Tooltip>
						</ButtonGroup>
					</Row>
				</Col>
				<Col xs={12} md={3}>
					<Row end="xs">
						<Col xs={12}>
							<Switch
								onChange={handleDefaultPlayerToggle}
								innerLabel={isDefaultPlayerTurnedOn ? t('ON') : t('OFF')}
								inline
								label={t('Default Video Player')}
								alignIndicator={Alignment.RIGHT}
								checked={isDefaultPlayerTurnedOn}
								disabled={!isFullScreenAPIAvailable}
								style={{
									marginBottom: '12px',
								}}
							/>
						</Col>
					</Row>
				</Col>
			</Row>
		</Card>
	);
}

export default PlayerControlPanel;
