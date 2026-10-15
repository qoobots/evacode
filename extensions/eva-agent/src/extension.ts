/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { EvaAgentSessions } from './sessions.js';

export function activate(context: vscode.ExtensionContext): void {
	const sessions = new EvaAgentSessions();
	context.subscriptions.push(sessions);
	sessions.register();
}

export function deactivate(): void {
	// nothing beyond the disposables registered on the extension context
}
