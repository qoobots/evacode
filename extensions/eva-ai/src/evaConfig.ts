/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Eva AI configuration, resolved from `eva-ai.*` settings.
 *
 * Two addresses are involved and they are deliberately separate, because they are served by
 * different services on the gateway:
 *  - `serverUrl` is the IAM service root used for login (OAuth2 authorization code + PKCE)
 *  - `baseUrl`   is the OpenAI-compatible AI gateway used for /models and /chat/completions
 *
 * When `baseUrl` is left empty we derive it the same way eva-desktop does: strip the
 * `/api/governance` suffix from the IAM server root and append `/api/ai/v1`.
 */
export interface EvaConfig {
	readonly iamServerUrl: string;
	readonly aiBaseUrl: string;
	readonly clientId: string;
	readonly defaultModel: string;
	readonly models: readonly string[];
	readonly temperature: number | undefined;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
}

const IAM_DEFAULT = 'http://localhost:8080/api/governance';
const GOVERNANCE_SUFFIX = '/api/governance';

function trimSlash(value: string): string {
	return value.trim().replace(/\/+$/, '');
}

function readString(section: vscode.WorkspaceConfiguration, key: string): string {
	const value = section.get<string>(key);
	return typeof value === 'string' ? trimSlash(value) : '';
}

function readNumber(section: vscode.WorkspaceConfiguration, key: string, fallback: number): number {
	const value = section.get<number>(key);
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function readConfig(): EvaConfig {
	const section = vscode.workspace.getConfiguration('eva-ai');

	const serverUrl = readString(section, 'serverUrl') || IAM_DEFAULT;
	const explicitBase = readString(section, 'baseUrl');
	let aiBaseUrl = explicitBase;
	if (!aiBaseUrl) {
		const root = serverUrl.endsWith(GOVERNANCE_SUFFIX) ? serverUrl.slice(0, -GOVERNANCE_SUFFIX.length) : serverUrl;
		aiBaseUrl = trimSlash(root) + '/api/ai/v1';
	}

	const models = (section.get<string[]>('models') ?? [])
		.map(value => typeof value === 'string' ? value.trim() : '')
		.filter(Boolean);

	return {
		iamServerUrl: serverUrl,
		aiBaseUrl,
		clientId: readString(section, 'clientId') || 'eva-desktop',
		defaultModel: readString(section, 'defaultModel'),
		models,
		temperature: typeof section.get<number>('temperature') === 'number' ? section.get<number>('temperature') : 0.2,
		maxInputTokens: readNumber(section, 'maxInputTokens', 128000),
		maxOutputTokens: readNumber(section, 'maxOutputTokens', 8192),
	};
}
