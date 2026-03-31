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
	const [activePR, setActivePR] = useState<{ number: number; owner: string; repo: string } | undefined>(undefined);
	const [isEditMode, setIsEditMode] = useState(true);
	const [handler, setHandler] = useState<MessageHandler | undefined>(undefined);

	useEffect(() => {
		const h = getMessageHandler((message: any) => {
			switch (message.command) {
				case 'codeTourEditor.initialize':
					setDoc(message.data);
					setActivePR(message.activePR);
					return;
				case 'codeTourEditor.updateActivePR':
					setActivePR(message.activePR);
					return;
				case 'codeTourEditor.toggleEditMode':
					setIsEditMode(prev => !prev);
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
		// Attach document PR properties to the hunk payload so the backend command has context
		const payload = { ...hunk };
		if (doc && doc.isPR !== undefined) {
			payload.isPR = doc.isPR;
			payload.prNumber = doc.prNumber;
			payload.prOwner = doc.prOwner;
			payload.prRepo = doc.prRepo;
			payload.baseRef = doc.baseRef;
		}

		handler?.postMessage({
			command: 'codeTourEditor.openDiff',
			args: { hunk: payload },
		});
	}, [handler, doc]);

	const onError = useCallback((message: string) => {
		handler?.postMessage({
			command: 'codeTourEditor.showError',
			args: { message },
		});
	}, [handler]);

	if (!doc) {
		return <div className="loading-indicator">Loading...</div>;
	}

	return (
		<CodeTourEditor
			document={doc}
			activePR={activePR}
			isEditMode={isEditMode}
			onDocumentChange={onDocumentChange}
			onInsertHunk={onInsertHunk}
			onOpenDiff={onOpenDiff}
			onError={onError}
		/>
	);
}
