import React, { useEffect, useState } from 'react';
import { PLAYER_WRAPPER_ID } from '../../constants/appConstants';

interface StreamStatsOverlayProps {
	stream: MediaStream | null;
}

interface StreamStats {
	fps: number;
	width: number;
	height: number;
	dropped: number;
}

const EMPTY_STATS: StreamStats = { fps: 0, width: 0, height: 0, dropped: 0 };

function findVideo(): HTMLVideoElement | null {
	const wrapper = document.getElementById(PLAYER_WRAPPER_ID);
	const video = wrapper?.querySelector('video');
	return video instanceof HTMLVideoElement ? video : null;
}

export default function StreamStatsOverlay({
	stream,
}: StreamStatsOverlayProps): React.ReactElement | null {
	const [stats, setStats] = useState<StreamStats>(EMPTY_STATS);

	useEffect(() => {
		if (!stream) {
			setStats(EMPTY_STATS);
			return;
		}

		let lastFrames = 0;
		let lastTime = performance.now();

		const interval = setInterval(() => {
			const video = findVideo();
			if (!video) {
				setStats(EMPTY_STATS);
				return;
			}

			const now = performance.now();
			const quality = video.getVideoPlaybackQuality?.();
			const webkitVideo = video as HTMLVideoElement & {
				webkitDecodedFrameCount?: number;
				webkitDroppedFrameCount?: number;
			};
			const totalFrames =
				quality?.totalVideoFrames ?? webkitVideo.webkitDecodedFrameCount ?? 0;
			const dropped =
				quality?.droppedVideoFrames ?? webkitVideo.webkitDroppedFrameCount ?? 0;
			const elapsed = (now - lastTime) / 1000;
			const fps =
				lastFrames > 0 && elapsed > 0
					? Math.max(0, Math.round((totalFrames - lastFrames) / elapsed))
					: 0;

			lastFrames = totalFrames;
			lastTime = now;

			setStats({
				fps,
				width: video.videoWidth,
				height: video.videoHeight,
				dropped,
			});
		}, 1000);

		return () => clearInterval(interval);
	}, [stream]);

	if (!stream) return null;

	return (
		<div
			style={{
				position: 'absolute',
				top: '8px',
				right: '8px',
				zIndex: 20,
				pointerEvents: 'none',
				background: 'rgba(0, 0, 0, 0.68)',
				color: '#7CFC00',
				fontFamily: 'monospace',
				fontSize: '12px',
				lineHeight: '1.4',
				padding: '4px 8px',
				borderRadius: '6px',
				textAlign: 'right',
			}}
		>
			<div>{stats.fps} FPS</div>
			<div>{stats.width > 0 ? `${stats.width}x${stats.height}` : '--'}</div>
			{stats.dropped > 0 ? <div>DROP {stats.dropped}</div> : null}
		</div>
	);
}
