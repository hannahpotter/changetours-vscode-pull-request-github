/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import { render } from 'react-dom';
import { ChangedFilesOverview } from './overview';
import { ChangedFileInfo } from '../../src/github/views';
import { getMessageHandler } from '../common/message';

interface ChangedFilesData {
	title: string;
	number: number;
	owner: string;
	repo: string;
	baseRef: string;
	files: ChangedFileInfo[];
}

export function main() {
	render(<Root />, document.getElementById('app'));
}

function Root() {
	const [data, setData] = useState<ChangedFilesData | undefined>(undefined);

	useEffect(() => {
		const handler = getMessageHandler((message: any) => {
			switch (message.command) {
				case 'pr.changedFiles.initialize':
					setData(message.data);
					return;
			}
		});
		handler.postMessage({ command: 'ready' });
	}, []);

	return data
		? <ChangedFilesOverview {...data} />
		: <div className="loading-indicator">Loading...</div>;
}
