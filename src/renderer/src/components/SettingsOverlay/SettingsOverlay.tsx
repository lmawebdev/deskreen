import React, { useCallback, useEffect, useState } from 'react';
import {
	Overlay2,
	Classes,
	H3,
	Tabs,
	Tab,
	Icon,
	Text,
	TabsExpander,
	HTMLSelect,
} from '@blueprintjs/core';
import { Col, Row } from 'react-flexbox-grid';
import { createStyles, makeStyles } from '@material-ui/core/styles';
import { LIGHT_UI_BACKGROUND } from '../../containers/SettingsProvider';
import CloseOverlayButton from '../CloseOverlayButton';
import SettingRowLabelAndInput from './SettingRowLabelAndInput';
import LanguageSelector from '../LanguageSelector';
import { IpcEvents } from '../../../../common/IpcEvents.enum';
import {
	DEFAULT_EXTENDED_DISPLAY_SETTINGS,
	EXTENDED_DISPLAY_BITRATE_OPTIONS,
	EXTENDED_DISPLAY_RESOLUTION_SCALES,
	type ExtendedDisplaySettings,
} from '../../../../common/ExtendedDisplaySettings';
import { useTranslation } from 'react-i18next';
import './settings-overlay.css';

interface SettingsOverlayProps {
	isSettingsOpen: boolean;
	handleClose: () => void;
}

type SettingsOverlayClassKey =
	| 'checkboxSettings'
	| 'overlayInnerRoot'
	| 'overlayInsideFade'
	| 'absoluteCloseButton'
	| 'tabNavigationRowButton'
	| 'iconInTablLeftButton'
	| 'updateCalloutWrapper'
	| 'updateCallout';

type SettingsOverlayClassMap = Record<SettingsOverlayClassKey, string>;

const useStyles = makeStyles(() =>
	createStyles({
		checkboxSettings: { margin: '0' },
		overlayInnerRoot: { width: '90%' },
		overlayInsideFade: {
			height: '90vh',
			backgroundColor: LIGHT_UI_BACKGROUND,
		},
		absoluteCloseButton: { position: 'absolute', left: 'calc(100% - 65px)' },
		tabNavigationRowButton: {
			fontWeight: 700,
			padding: '6px 10px',
			borderRadius: '100px',
		},
		iconInTablLeftButton: { marginRight: '5px' },
		updateCalloutWrapper: {
			display: 'flex',
			justifyContent: 'center',
			marginBottom: '16px',
			width: '100%',
		},
		updateCallout: {
			cursor: 'pointer',
			boxShadow: 'none',
			display: 'inline-flex',
			flexDirection: 'column',
			gap: '4px',
			width: 'auto',
			maxWidth: '420px',
			borderRadius: '8px',
		},
	}),
);

export default function SettingsOverlay(
	props: SettingsOverlayProps,
): React.ReactElement {
	const [clientViewerPort, setClientViewerPort] = useState('80'); // Default port, can be changed later

	const { handleClose, isSettingsOpen } = props;
	const [currentVersion, setCurrentVersion] = useState('');
	const [extendedDisplaySettings, setExtendedDisplaySettings] =
		useState<ExtendedDisplaySettings>(DEFAULT_EXTENDED_DISPLAY_SETTINGS);

	const { t } = useTranslation();

	const classes = useStyles() as SettingsOverlayClassMap;

	useEffect(() => {
		window.electron.ipcRenderer
			.invoke(IpcEvents.GetPort)
			.then((port) => {
				return setClientViewerPort(port);
			})
			.catch((error) => {
				console.error('Error getting port:', error);
			});

		return () => {
			window.electron.ipcRenderer.removeListener(
				'settings-overlay-close',
				handleClose,
			);
		};
	}, [handleClose]);

	useEffect(() => {
		const getCurrentVersion = async (): Promise<void> => {
			const gotCurrentVersion = await window.electron.ipcRenderer.invoke(
				'get-current-version',
			);
			if (gotCurrentVersion !== '') {
				setCurrentVersion(gotCurrentVersion);
			}
		};
		getCurrentVersion();
	}, []);

	useEffect(() => {
		window.electron.ipcRenderer
			.invoke(IpcEvents.GetExtendedDisplaySettings)
			.then((settings: Partial<ExtendedDisplaySettings> | undefined) => {
				if (!settings) return;

				setExtendedDisplaySettings((previous) => ({
					frameRate: settings.frameRate ?? previous.frameRate,
					bitrateMbps: settings.bitrateMbps ?? previous.bitrateMbps,
					resolutionScale:
						settings.resolutionScale ?? previous.resolutionScale,
					priority: settings.priority ?? previous.priority,
				}));
			})
			.catch((error) => {
				console.error('failed to load extended display settings', error);
			});
	}, []);

	const handleExtendedDisplaySettingsChange = useCallback(
		(partial: Partial<ExtendedDisplaySettings>): void => {
			setExtendedDisplaySettings((previous) => ({
				...previous,
				...partial,
			}));
			void window.electron.ipcRenderer.invoke(
				IpcEvents.SetExtendedDisplaySettings,
				partial,
			);
		},
		[],
	);

	const GeneralSettingsPanel: React.FC = () => {
		return (
			<div style={{ width: '100%' }}>
				<Row middle="xs">
					<H3 className="bp3-text-muted">{t('general-settings')}</H3>
				</Row>

				{/*<SettingRowLabelAndInput*/}
				{/*  icon="style"*/}
				{/*  label={t('color-theme')}*/}
				{/*  input={<ToggleThemeBtnGroup />}*/}
				{/*/>*/}
				<div style={{ marginTop: '24px' }}>
					<SettingRowLabelAndInput
						icon="translate"
						label={t('language')}
						input={<LanguageSelector />}
					/>
				</div>

				<div style={{ marginTop: '24px' }}>
					<Row middle="xs">
						<H3 className="bp3-text-muted">
							{t('extended-display-quality')}
						</H3>
					</Row>
					<Text
						className="bp3-text-muted"
						style={{ fontSize: '13px', marginBottom: '12px' }}
					>
						{t('extended-display-quality-live-note')}
					</Text>

					<SettingRowLabelAndInput
						icon="dashboard"
						label={t('extended-display-frame-rate')}
						input={
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
						}
					/>
					<SettingRowLabelAndInput
						icon="feed"
						label={t('extended-display-bitrate')}
						input={
							<HTMLSelect
								value={extendedDisplaySettings.bitrateMbps}
								onChange={(event) => {
									handleExtendedDisplaySettingsChange({
										bitrateMbps: Number(event.currentTarget.value),
									});
								}}
								options={EXTENDED_DISPLAY_BITRATE_OPTIONS.map(
									(bitrate) => ({
										value: bitrate,
										label: `${bitrate} Mbps`,
									}),
								)}
							/>
						}
					/>
					<SettingRowLabelAndInput
						icon="zoom-to-fit"
						label={t('extended-display-resolution')}
						input={
							<HTMLSelect
								value={extendedDisplaySettings.resolutionScale}
								onChange={(event) => {
									handleExtendedDisplaySettingsChange({
										resolutionScale: Number(
											event.currentTarget.value,
										) as ExtendedDisplaySettings['resolutionScale'],
									});
								}}
								options={EXTENDED_DISPLAY_RESOLUTION_SCALES.map(
									(scale) => ({
										value: scale,
										label: `${scale}x`,
									}),
								)}
							/>
						}
					/>
					<SettingRowLabelAndInput
						icon="lightning"
						label={t('extended-display-priority')}
						input={
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
						}
					/>
					<Text
						className="bp3-text-muted"
						style={{ fontSize: '13px', marginTop: '6px' }}
					>
						{t('extended-display-bitrate-description')}
					</Text>
				</div>

				<Row
					center="xs"
					middle="xs"
					style={{ marginTop: '40px', width: '100%' }}
				>
					<div>
						<Col xs={12}>
							<img
								src={`http://127.0.0.1:${clientViewerPort}/logo512.png`}
								alt="logo"
								style={{ width: '100px' }}
							/>
						</Col>
						<Col xs={12}>
							<H3>{t('about-deskreen')}</H3>
						</Col>
						<Col xs={12}>
							<Text>{`${t('version')}: ${currentVersion} (${currentVersion})`}</Text>
						</Col>
						<Col xs={12}>
							<Text>
								{`${t('copyright')} © ${new Date().getFullYear()} `}
								<a
									href="https://www.linkedin.com/in/pavlobu/"
									target="_blank"
									rel="noopener noreferrer"
									className="bp3-link"
									style={{
										color: '#106ba3',
										textDecoration: 'none',
									}}
								>
									Pavlo Buidenkov
								</a>
							</Text>
						</Col>
						<Col xs={12}>
							<Text>
								{`${t('website')}: `}
								<a
									href="https://www.deskreen.com"
									target="_blank"
									rel="noopener noreferrer"
									className="bp3-link"
									style={{
										color: '#106ba3',
										textDecoration: 'none',
									}}
								>
									https://www.deskreen.com
								</a>
							</Text>
						</Col>
					</div>
				</Row>
			</div>
		);
	};

	const getTabNavGeneralSettingsButton = (): React.ReactElement => {
		return (
			<Row middle="xs" className={classes.tabNavigationRowButton}>
				<Icon icon="wrench" className={classes.iconInTablLeftButton} />
				<Text className="bp3-text-large">{t('general')}</Text>
			</Row>
		);
	};

	return (
		<Overlay2
			onClose={handleClose}
			className={`${Classes.OVERLAY_SCROLL_CONTAINER} bp3-overlay-settings`}
			autoFocus
			canEscapeKeyClose
			canOutsideClickClose
			enforceFocus
			hasBackdrop
			isOpen={isSettingsOpen}
			usePortal
			transitionDuration={0}
		>
			<div className={classes.overlayInnerRoot}>
				<div
					id="settings-overlay-inner"
					className={`${classes.overlayInsideFade} ${Classes.CARD}`}
					style={{
						borderRadius: '8px',
					}}
				>
					<CloseOverlayButton
						className={classes.absoluteCloseButton}
						onClick={handleClose}
						isDefaultStyles
					/>
					<Tabs
						animate
						id="TabsExample"
						key="vertical"
						renderActiveTabPanelOnly
						vertical
					>
						<Tab
							id="rx"
							title=""
							panel={<GeneralSettingsPanel />}
							panelClassName={'tab-panel-wide-custom-style'}
						>
							{getTabNavGeneralSettingsButton()}
						</Tab>
						<TabsExpander />
					</Tabs>
				</div>
			</div>
		</Overlay2>
	);
}
