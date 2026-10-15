/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { type DroppableParamName, type ModelAdapter } from './evaAdapters';
import { beginTrace, readTraceConfig, type EvaTraceSpan } from './evaTrace';

/**
 * Streaming client for OpenAI-compatible chat endpoints, EVA's own gateway among them.
 *
 * Three behaviours of these endpoints drive the design and are easy to get wrong:
 *
 * 1. Errors can arrive inside a **200** response. A rejected parameter (seen for `kimi-k3`, which
 *    refuses `temperature`) surfaces as a `{"error": ...}` SSE frame, not a failing HTTP status.
 *    So the stream body has to be inspected, not just `response.ok`.
 *
 * 2. Streamed `tool_calls` arrive **fragmented**: each chunk carries a slice of
 *    `delta.tool_calls[i].function.arguments`. The arguments must be concatenated per index; taking
 *    only the last fragment yields truncated JSON. The same trap is documented in eva-desktop's
 *    `apps/agent-ts/src/llm.ts`.
 *
 * 3. The assistant tool calls we receive are flat `{id, name, arguments}` while the wire expects
 *    `{id, type:'function', function:{name, arguments}}`. Sending the flat shape back on history
 *    replays silently confuses the model (also documented in eva-desktop).
 *
 * Everything that genuinely differs *between* endpoints lives in `evaAdapters` instead of here.
 */

export interface EvaToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
}

/** Real token counts, as reported by the endpoint (only when `stream_options.include_usage` is set). */
export interface EvaUsage {
	readonly prompt_tokens?: number;
	readonly completion_tokens?: number;
	readonly total_tokens?: number;
}

export interface EvaStreamHandlers {
	onText(text: string): void;
	onThinking(text: string): void;
	onToolCall(calls: readonly EvaToolCall[]): void;
	onUsage?(usage: EvaUsage): void;
}

export interface EvaChatRequest {
	readonly baseUrl: string;
	readonly token: string;
	/** Which model source this goes to, so a trace can be attributed when several are configured. */
	readonly source?: string;
	readonly model: string;
	readonly messages: readonly vscode.LanguageModelChatRequestMessage[];
	readonly tools: readonly vscode.LanguageModelChatTool[] | undefined;
	readonly temperature: number | undefined;
	readonly maxOutputTokens: number;
	readonly signal: AbortSignal;
	readonly handlers: EvaStreamHandlers;
	/** Endpoint-specific behaviour: thinking field, degradation rules, vision. */
	readonly adapter: ModelAdapter;
}

interface WireToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

/**
 * One part of a multimodal user message.
 *
 * `content` is a plain string for text-only turns, because that is what every endpoint accepts, and
 * only becomes an array when an image is actually attached.
 */
export interface WireContentPart {
	type: 'text' | 'image_url';
	text?: string;
	image_url?: { url: string };
}

export interface WireMessage {
	role: string;
	content?: string | WireContentPart[];
	name?: string;
	tool_calls?: WireToolCall[];
	tool_call_id?: string;
}

/** Signals that a parameter must be dropped and the request repeated. */
class RetryWithoutParam extends Error {
	constructor(readonly param: DroppableParamName) {
		super();
	}
}

/**
 * Sends the request, shedding optional parameters the endpoint turns out not to support.
 *
 * Terminates because each parameter can only go from present to dropped, so there are at most one
 * more attempts than there are droppable parameters.
 */
export async function streamChat(request: EvaChatRequest): Promise<void> {
	const dropped = new Set<DroppableParamName>();

	for (; ;) {
		try {
			await runOnce(request, dropped);
			return;
		} catch (err) {
			if (err instanceof RetryWithoutParam && !dropped.has(err.param)) {
				dropped.add(err.param);
				continue;
			}
			if (isAbort(err, request.signal)) {
				return;
			}
			throw err;
		}
	}
}

async function runOnce(request: EvaChatRequest, dropped: ReadonlySet<DroppableParamName>): Promise<void> {
	const url = `${trimSlash(request.baseUrl)}/chat/completions`;
	const tools = wireTools(request.tools);

	const body: Record<string, unknown> = {
		model: request.model,
		messages: toWireMessages(request.messages, request.model, request.adapter),
		stream: true,
		max_tokens: request.maxOutputTokens,
	};
	// Without this the endpoint omits `usage` from every frame; with it we get real token counts
	// instead of having to estimate them. Omitted entirely when unsupported, rather than sent as
	// false, because a server that rejects the key is unlikely to accept the value either.
	if (!dropped.has('stream_options')) {
		body.stream_options = { include_usage: true };
	}
	if (typeof request.temperature === 'number' && !dropped.has('temperature')) {
		body.temperature = request.temperature;
	}
	if (tools) {
		body.tools = tools;
	}

	// Captured after the body is complete and before it is sent, so the log holds exactly what the
	// endpoint receives. This is the only route the Chat view and agent sessions take to EVA.
	const span = beginTrace(readTraceConfig(), {
		source: request.source ?? 'copilot',
		route: 'POST /chat/completions',
		url,
		model: request.model,
		request: body,
	});

	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${request.token}`,
			},
			body: JSON.stringify(body),
			signal: request.signal,
		});
	} catch (err) {
		span?.fail(err);
		if (isAbort(err, request.signal)) {
			return;
		}
		throw new Error(`连不上模型端点（${url}）：${err instanceof Error ? err.message : String(err)}`);
	}

	if (!response.ok || !response.body) {
		const text = await response.text().catch(() => '');
		span?.fail(`HTTP ${response.status}：${text.slice(0, 300)}`, response.status);
		// A self-hosted endpoint reports an unsupported parameter as an ordinary 400, so the
		// degradation has to be recognised here too and not only inside the 200 stream.
		const param = findDroppableParam(text, dropped, request.adapter);
		if (param) {
			throw new RetryWithoutParam(param);
		}
		throw new Error(`模型端点返回 HTTP ${response.status}${response.status === 401 || response.status === 403 ? '（Key 无效或登录态已失效）' : ''}：${text.slice(0, 300)}`);
	}

	try {
		await readStream(response, request, dropped, span);
		span?.finish(response.status);
	} catch (err) {
		span?.fail(err, response.status);
		throw err;
	}
}

/**
 * Matches an endpoint's complaint against the parameters we could still drop.
 *
 * A parameter that was never sent cannot be what the endpoint is complaining about, so already
 * dropped ones are skipped - without that, a response mentioning both parameters would loop.
 */
function findDroppableParam(errorText: string, dropped: ReadonlySet<DroppableParamName>, adapter: ModelAdapter): DroppableParamName | undefined {
	for (const param of adapter.droppableParams) {
		if (!dropped.has(param.name) && param.pattern.test(errorText)) {
			return param.name;
		}
	}
	return undefined;
}

async function readStream(response: Response, request: EvaChatRequest, dropped: ReadonlySet<DroppableParamName>, span: EvaTraceSpan | undefined): Promise<void> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const pending = new Map<number, { id: string; name: string; args: string }>();
	let buffer = '';

	try {
		for (; ;) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			// SSE frames are separated by a blank line, so one read is not guaranteed to be one frame.
			const parts = buffer.split('\n');
			buffer = parts.pop() ?? '';

			for (const line of parts) {
				const trimmed = line.trim();
				if (!trimmed.startsWith('data:')) {
					continue;
				}
				const payload = trimmed.slice(5).trim();
				if (!payload || payload === '[DONE]') {
					continue;
				}
				let frame: any;
				try {
					frame = JSON.parse(payload);
				} catch {
					continue;
				}

				// Upstream failures ride along inside a 200 response.
				const errorText = extractUpstreamError(frame);
				if (errorText) {
					const param = findDroppableParam(errorText, dropped, request.adapter);
					if (param) {
						throw new RetryWithoutParam(param);
					}
					throw new Error(`模型端点上游错误：${errorText}`);
				}

				if (frame?.usage) {
					request.handlers.onUsage?.(frame.usage);
					span?.noteUsage(frame.usage);
				}

				const choice = frame?.choices?.[0];
				if (!choice) {
					continue;
				}
				const delta = choice.delta ?? {};

				if (typeof delta.content === 'string' && delta.content) {
					request.handlers.onText(delta.content);
					span?.noteText(delta.content);
				}

				// Which field carries reasoning is up to the endpoint; see `evaAdapters`.
				const thinking = readThinking(delta, request.adapter);
				if (thinking) {
					request.handlers.onThinking(thinking);
					span?.noteText(thinking, 'thinking');
				}

				if (Array.isArray(delta.tool_calls)) {
					for (const fragment of delta.tool_calls) {
						const index = Number(fragment.index ?? 0);
						const current = pending.get(index) ?? { id: '', name: '', args: '' };
						if (fragment.id) {
							current.id = fragment.id;
						}
						if (fragment.function?.name) {
							current.name = fragment.function.name;
						}
						if (typeof fragment.function?.arguments === 'string') {
							current.args += fragment.function.arguments;
						}
						pending.set(index, current);
					}
				}

				if (choice.finish_reason) {
					emitToolCalls(pending, request.handlers, span);
					return;
				}
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// stream already finished
		}
	}

	// The stream ended without a finish_reason: still deliver whatever tool calls accumulated.
	emitToolCalls(pending, request.handlers, span);
}

function readThinking(delta: any, adapter: ModelAdapter): string | undefined {
	for (const field of adapter.thinkingFields) {
		const value = delta?.[field];
		if (typeof value === 'string' && value) {
			return value;
		}
	}
	return undefined;
}

function emitToolCalls(pending: Map<number, { id: string; name: string; args: string }>, handlers: EvaStreamHandlers, span: EvaTraceSpan | undefined): void {
	const calls: EvaToolCall[] = [...pending.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([, value]) => ({ id: value.id, name: value.name, arguments: value.args }))
		.filter(call => call.name);
	if (calls.length) {
		handlers.onToolCall(calls);
		span?.noteToolCall(calls);
	}
}

function extractUpstreamError(frame: any): string | undefined {
	if (!frame) {
		return undefined;
	}
	if (typeof frame.error === 'string' && frame.error) {
		return frame.error;
	}
	if (frame.error && typeof frame.error === 'object') {
		const nested = frame.error.message ?? frame.error.error_description;
		if (typeof nested === 'string' && nested) {
			return nested;
		}
	}
	return undefined;
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
	return signal.aborted || (err instanceof Error && err.name === 'AbortError');
}

export function toWireMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	modelId: string,
	adapter: ModelAdapter,
): WireMessage[] {
	const wire: WireMessage[] = [];
	const canSeeImages = adapter.supportsImages(modelId);

	for (const message of messages) {
		let text = '';
		const images: WireContentPart[] = [];
		const toolCalls: WireToolCall[] = [];
		const toolResults: WireMessage[] = [];

		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
			} else if (part instanceof vscode.LanguageModelDataPart) {
				if (!canSeeImages) {
					// Not dropped silently: the model should still know an image was attached, and
					// sending it anyway would be rejected outright by some endpoints.
					continue;
				}
				const url = toDataUrl(part);
				if (url) {
					images.push({ type: 'image_url', image_url: { url } });
				}
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push({
					role: 'tool',
					tool_call_id: part.callId,
					content: stringifyToolResult(part.content),
				});
			}
		}

		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			if (!text && !toolCalls.length) {
				continue;
			}
			wire.push({
				role: 'assistant',
				content: text,
				tool_calls: toolCalls.length ? toolCalls : undefined,
			});
			continue;
		}

		if (images.length) {
			// Multimodal turns need the array form; a bare string would drop the image.
			const parts: WireContentPart[] = [];
			if (text) {
				parts.push({ type: 'text', text });
			}
			parts.push(...images);
			wire.push({ role: 'user', content: parts });
		} else if (text) {
			wire.push({ role: 'user', content: text });
		}
		wire.push(...toolResults);
	}

	return wire;
}

/**
 * Inlines an image as a data URL, which is what every OpenAI-compatible endpoint takes.
 *
 * Falls back to `undefined` for a non-image part rather than inventing a MIME type: a data URL that
 * claims the wrong type is worse than no image at all.
 */
function toDataUrl(part: vscode.LanguageModelDataPart): string | undefined {
	const mime = part.mimeType;
	if (typeof mime !== 'string' || !mime.startsWith('image/')) {
		return undefined;
	}
	return `data:${mime};base64,${toBase64(part.data)}`;
}

function toBase64(bytes: Uint8Array): string {
	if (typeof Buffer !== 'undefined') {
		return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
	}
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function stringifyToolResult(content: readonly unknown[]): string {
	const parts: string[] = [];
	for (const part of content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			parts.push(part.value);
		} else if (part instanceof vscode.LanguageModelPromptTsxPart) {
			parts.push(part.value instanceof Error ? part.value.message : String(part.value ?? ''));
		} else if (typeof part === 'string') {
			parts.push(part);
		} else if (part instanceof Error) {
			parts.push(part.message);
		} else if (part !== undefined && part !== null) {
			try {
				parts.push(JSON.stringify(part));
			} catch {
				parts.push(String(part));
			}
		}
	}
	return parts.join('\n') || '(empty)';
}

function wireTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): unknown[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	return tools.map(tool => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema ?? { type: 'object', properties: {} },
		},
	}));
}

function trimSlash(value: string): string {
	return value.replace(/\/+$/, '');
}
