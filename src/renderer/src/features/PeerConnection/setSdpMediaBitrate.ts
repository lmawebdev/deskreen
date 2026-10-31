export default (sdp: string, mediaType: string, bitrate: number): string => {
	const sdpLines = sdp.split('\n');
	const mediaLine = `m=${mediaType}`;
	const mediaLineIndex = sdpLines.findIndex((line) => line.startsWith(mediaLine));

	if (mediaLineIndex === -1 || mediaLineIndex >= sdpLines.length) {
		return sdp;
	}

	let bitrateLineIndex = mediaLineIndex + 1;

	while (
		bitrateLineIndex < sdpLines.length &&
		(sdpLines[bitrateLineIndex].startsWith('i=') ||
			sdpLines[bitrateLineIndex].startsWith('c='))
	) {
		bitrateLineIndex += 1;
	}

	const bitrateLine = `b=AS:${bitrate}`;

	if (bitrateLineIndex < sdpLines.length) {
		if (sdpLines[bitrateLineIndex].startsWith('b=')) {
			sdpLines[bitrateLineIndex] = bitrateLine;
		} else {
			sdpLines.splice(bitrateLineIndex, 0, bitrateLine);
		}
	}

	return sdpLines.join('\n');
};
