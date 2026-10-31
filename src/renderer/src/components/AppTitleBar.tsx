import React from 'react';

const isMac = navigator.userAgent.includes('Mac');

export default function AppTitleBar(): React.ReactElement {
	return (
		<div className={`app-title-bar${isMac ? ' app-title-bar--mac' : ''}`}>
			<div className="app-title-bar-brand">
				<span className="app-title-bar-mark">D</span>
				<span>Deskreen</span>
			</div>
			<div className="app-title-bar-status">
				<span className="app-status-dot" />
				Local session
			</div>
		</div>
	);
}
