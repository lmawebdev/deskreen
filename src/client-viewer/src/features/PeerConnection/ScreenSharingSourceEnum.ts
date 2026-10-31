export const ScreenSharingSource = {
	WINDOW: 'window',
	SCREEN: 'screen',
	EXTENDED: 'extended',
} as const;

export type ScreenSharingSourceType =
	(typeof ScreenSharingSource)[keyof typeof ScreenSharingSource];
