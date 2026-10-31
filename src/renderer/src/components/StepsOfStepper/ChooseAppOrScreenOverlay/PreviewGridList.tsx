import { Col, Row } from 'react-flexbox-grid';
import { IpcEvents } from '../../../../../common/IpcEvents.enum';
import SharingSourcePreviewCard from '../../SharingSourcePreviewCard';

interface PreviewGridListProps {
	viewSharingIds: string[];
	isEntireScreen: boolean;
	handleNextEntireScreen: () => void;
	handleNextApplicationWindow: () => void;
}

export default function PreviewGridList(props: PreviewGridListProps) {
	const {
		viewSharingIds,
		isEntireScreen,
		handleNextEntireScreen,
		handleNextApplicationWindow,
	} = props;

	return (
		<Row
			center="xs"
			around="xs"
			style={{
				height: '90%',
			}}
		>
			{viewSharingIds.map((id) => {
				return (
					<Col xs={12} md={6} key={id}>
						<SharingSourcePreviewCard
							sharingSourceID={id}
							isChangeAppearanceOnHover
							onClickCard={async () => {
								window.electron.ipcRenderer.invoke(
									IpcEvents.SetDesktopCapturerSourceId,
									id,
								);
								if (isEntireScreen) {
									handleNextEntireScreen();
								} else {
									handleNextApplicationWindow();
								}
							}}
						/>
					</Col>
				);
			})}
		</Row>
	);
}
