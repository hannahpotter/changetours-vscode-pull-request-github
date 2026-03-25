/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useState } from 'react';
import { render } from 'react-dom';
import { CodeTourEditor } from './codeTourEditor';

import type { CodeTourDocument } from '../../src/github/codeTourMarkdown';
import { getMessageHandler, MessageHandler } from '../common/message';

export function main() {
	render(<Root />, document.getElementById('app'));
}

function Root() {
	const [doc, setDoc] = useState<CodeTourDocument | undefined>(undefined);
	const [handler, setHandler] = useState<MessageHandler | undefined>(undefined);

	useEffect(() => {
		const h = getMessageHandler((message: any) => {
			switch (message.command) {
				case 'codeTourEditor.initialize':
					setDoc(message.data);
					return;
			}
		});
		setHandler(h);
		h.postMessage({ command: 'ready' });
	}, []);

	const onDocumentChange = useCallback((markdown: string) => {
		handler?.postMessage({
			command: 'codeTourEditor.updateDocument',
			args: { markdown },
		});
	}, [handler]);

	const onInsertHunk = useCallback((hunk: any) => {
		handler?.postMessage({
			command: 'codeTourEditor.insertHunk',
			args: { hunk },
		});
	}, [handler]);

	const onOpenDiff = useCallback((hunk: any) => {
		handler?.postMessage({
			command: 'codeTourEditor.openDiff',
			args: { hunk },
		});
	}, [handler]);

	if (!doc) {
		return <div className="loading-indicator">Loading...</div>;
	}

	return (
		<CodeTourEditor
			document={doc}
			onDocumentChange={onDocumentChange}
			onInsertHunk={onInsertHunk}
			onOpenDiff={onOpenDiff}
		/>
	);
}
