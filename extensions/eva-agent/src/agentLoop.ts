/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { EvaSessionRecord } from './sessions.js';

export interface TurnRequest {
	readonly record: EvaSessionRecord;
	readonly request: vscode.ChatRequest;
	readonly stream: vscode.ChatResponseStream;
	readonly token: vscode.CancellationToken;
}

/** Safety cap used when the configuration is missing; see `eva-agent.maxTurns`. */
const DEFAULT_MAX_TURNS = 24;

/**
 * Runs one agent turn: send the transcript to the model, carry out whatever it asks for,
 * feed the results back, and repeat until it stops asking for tools.
 *
 * This is deliberately the smallest loop that can do real work. Everything that makes it
 * *good* — grounding tools, context budgeting, compaction, the verification gate — is added
 * around it, not inside it.
 */
export async function runTurn(turn: TurnRequest): Promise<void> {
	const { record, request, stream, token } = turn;

	const model = await resolveModel();
	if (!model) {
		stream.markdown(
			'没有可用的模型。请确认已经登录 Eva AI（`Eva AI: 登录`），或已在 `eva-ai.byok.sources` 里配好某个来源的 API Key；' +
			'并把该来源的 id 加进 `eva-agent.modelVendors`。'
		);
		return;
	}

	record.messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

	const maxTurns = vscode.workspace.getConfiguration('eva-agent').get<number>('maxTurns') ?? DEFAULT_MAX_TURNS;

	for (let round = 0; round < maxTurns; round++) {
		if (token.isCancellationRequested) {
			return;
		}

		const response = await model.sendRequest(record.messages, { tools: collectTools() }, token);

		const toolCalls: vscode.LanguageModelToolCallPart[] = [];
		for await (const part of response.stream) {
			if (token.isCancellationRequested) {
				return;
			}
			if (part instanceof vscode.LanguageModelTextPart) {
				stream.markdown(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push(part);
			}
		}

		// No tool calls means the model considers the turn answered.
		if (!toolCalls.length) {
			return;
		}

		record.messages.push(vscode.LanguageModelChatMessage.Assistant(toolCalls));

		for (const call of toolCalls) {
			const result = await vscode.lm.invokeTool(
				call.name,
				{ input: call.input, toolInvocationToken: request.toolInvocationToken },
				token,
			);
			record.messages.push(vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart(call.callId, result.content),
			]));
		}
	}

	stream.markdown(`\n\n（已到达 eva-agent.maxTurns 上限 ${maxTurns} 轮，未完成任务。）`);
}

/**
 * Every tool registered in the editor, handed to the model as-is.
 *
 * TODO(P2): this is the opposite of "few and well-chosen". Once the grounding tools exist the
 * set must be curated — a large, undifferentiated tool list is reliably harder for the model to
 * pick from, and costs context on every single request.
 */
function collectTools(): vscode.LanguageModelChatTool[] {
	return vscode.lm.tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
	}));
}

/**
 * Picks a model, walking the configured vendors in order.
 *
 * A list rather than a single vendor because which source has a usable credential is not knowable
 * ahead of time: the EVA gateway needs a login, a BYOK source needs its key, and a machine may well
 * have one but not the other. Taking the first vendor that yields anything is what lets the agent
 * work in a setup where only a BYOK endpoint is configured.
 */
async function resolveModel(): Promise<vscode.LanguageModelChat | undefined> {
	const vendors = vscode.workspace.getConfiguration('eva-agent').get<string[]>('modelVendors') ?? ['eva-ai'];
	for (const vendor of vendors) {
		const models = await vscode.lm.selectChatModels({ vendor });
		if (models.length) {
			return models[0];
		}
	}
	return undefined;
}
