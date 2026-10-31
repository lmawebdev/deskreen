import React from 'react';
import { Col, Row } from 'react-flexbox-grid';
import ShareEntireScreenOrAppWindowControlGroup from '../ShareAppOrScreenControlGroup';

interface ChooseAppOrScreenStepProps {
	handleNextEntireScreen: () => void;
	handleNextApplicationWindow: () => void;
	handleNextExtendedDisplay: () => void;
}

const ChooseAppOrScreenStep: React.FC<ChooseAppOrScreenStepProps> = ({
	handleNextEntireScreen,
	handleNextApplicationWindow,
	handleNextExtendedDisplay,
}: ChooseAppOrScreenStepProps) => {
	return (
		<Row style={{ width: '100%' }}>
			<Col xs={12}>
				<Row center="xs">
					<Col>
						<ShareEntireScreenOrAppWindowControlGroup
							handleNextEntireScreen={handleNextEntireScreen}
							handleNextApplicationWindow={handleNextApplicationWindow}
							handleNextExtendedDisplay={handleNextExtendedDisplay}
						/>
					</Col>
				</Row>
			</Col>
		</Row>
	);
};

export default ChooseAppOrScreenStep;
