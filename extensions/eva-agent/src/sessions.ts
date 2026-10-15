/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { runTurn } from './agentLoop.js';

/** Must match `contributes.chatSessions[].type` in package.json, or the session type never shows up. */
export const SESSION_TYPE = 'eva-agent';

/**
 * One conversation.
 *
 * `messages` is the transcript handed to the model; `label` is what the session list shows.
 */
export interface EvaSessionRecord {
	readonly resource: vscode.Uri;
	label: string;
	messages: vscode.LanguageModelChatMessage[];
}

/**
 * Owns the session list and the session contents for the `eva-agent` session type.
 *
 * Storage is in-memory for now: the point of this first cut is the loop, not durability.
 */
export class EvaAgentSessions implements vscode.Disposable {

	private readonly records = new Map<string, EvaSessionRecord>();
	private readonly disposables: vscode.Disposable[] = [];
	private controller: vscode.ChatSessionItemController | undefined;

	register(): void {
		const controller = vscode.chat.createChatSessionItemController(SESSION_TYPE, async () => {
			await this.refresh(controller);
		});
		this.controller = controller;
		this.disposables.push(controller);

		controller.newChatSessionItemHandler = async (context) => {
			const id = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
			const resource = vscode.Uri.from({ scheme: SESSION_TYPE, path: `/${id}` });
			const label = context.request.prompt?.trim() || 'New session';
			this.records.set(resource.toString(), { resource, label, messages: [] });
			const item = controller.createChatSessionItem(resource, label);
			controller.items.add(item);
			return item;
		};

		const participant = vscode.chat.createChatParticipant(SESSION_TYPE, this.createRequestHandler());
		this.disposables.push(participant);
		this.disposables.push(vscode.chat.registerChatSessionContentProvider(
			SESSION_TYPE,
			{ provideChatSessionContent: (resource) => this.provideContent(resource) },
			participant,
			{ supportsInterruptions: true },
		));

		void this.refresh(controller);
	}

	private async refresh(controller: vscode.ChatSessionItemController): Promise<void> {
		const items = [...this.records.values()].map(record => controller.createChatSessionItem(record.resource, record.label));
		controller.items.replace(items);
	}

	private provideContent(resource: vscode.Uri): vscode.ChatSession {
		const record = this.records.get(resource.toString())
			?? { resource, label: 'Eva Agent', messages: [] };
		this.records.set(resource.toString(), record);

		return {
			title: record.label,
			// TODO(1.3b): replaying `history` needs `ChatResponseTurn2`, which lives behind the
			// `chatParticipantPrivate` proposal. Until that is decided, a reopened session starts
			// empty in the UI even though `messages` still carries the model transcript.
			history: [],
			requestHandler: (request, _context, stream, token) => this.handle(record, request, stream, token),
		};
	}

	private createRequestHandler(): vscode.ChatRequestHandler {
		return async (request, _context, stream, token) => {
			// `ChatRequest.sessionResource` is proposal-only (`chatParticipantPrivate`), so a request
			// that reaches the participant without going through `provideChatSessionContent` cannot
			// be tied back to a session. It gets its own throwaway conversation instead.
			const resource = vscode.Uri.from({ scheme: SESSION_TYPE, path: `/adhoc-${Date.now().toString(36)}` });
			const record = this.records.get(resource.toString())
				?? { resource, label: request.prompt.trim() || 'Eva Agent', messages: [] };
			this.records.set(resource.toString(), record);
			await this.handle(record, request, stream, token);
		};
	}

	private async handle(
		record: EvaSessionRecord,
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<void> {
		await runTurn({ record, request, stream, token });
		const controller = this.controller;
		if (controller) {
			await this.refresh(controller);
		}
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
		this.controller = undefined;
	}
}
