/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { beginTrace, readTraceConfig, type EvaTraceSpan } from './evaTrace';

/**
 * Streaming client for the EVA AI OpenAI-compatible chat endpoint.
 *
 * Two behaviours of this gateway drive the design and are easy to get wrong:
 *
 * 1. Errors can arrive inside a **200** response. A rejected parameter (seen for `kimi-k3`, which
 *    refuses `temperature`) surfaces as a `{"error": ...}` SSE frame, not a failing HTTP status.
 *    So the stream body has to be inspected, not just `response.ok`. When the complaint is about
 *    an unsupported parameter we retry once without it instead of failing the request.
 *
 * 2. Streamed `tool_calls` arrive **fragmented**: each chunk carries a slice of
 *    `delta.tool_calls[i].function.arguments`. The arguments must be concatenated per index; taking
 *    only the last fragment yields truncated JSON. The same trap is documented in eva-desktop's
 *    `apps/agent-ts/src/llm.ts`.
 *
 * Also note that the assistant tool calls we receive are flat `{id, name, arguments}` while the
 * wire expects `{id, type:'function', function:{name, arguments}}`. Sending the flat shape back on
 * history replays silently confuses the model (documented in eva-desktop too).
 */

export interface EvaToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
}

/** Real token counts, as reported by the gateway (only when `stream_options.include_usage` is set). */
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
}

interface WireToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export interface WireMessage {
	role: string;
	content?: string;
	name?: string;
	tool_calls?: WireToolCall[];
	tool_call_id?: string;
}

/** Marks a parameter rejected by the upstream model, to retry once without it. */
class RetryWithoutTemperature extends Error { }

/**
 * Marks an endpoint that does not understand `stream_options`.
 *
 * The EVA gateway needs it to report token counts, but it is not a universal part of the
 * OpenAI-compatible contract: self-hosted servers (vLLM, Ollama and friends) reject it outright.
 * Those endpoints are exactly the "point this at a model I run myself" case, so the response is to
 * retry without it rather than to declare the endpoint unusable - we lose the real token counts and
 * fall back to estimating them, which is a smaller loss than no endpoint at all.
 */
class RetryWithoutStreamOptions extends Error { }

/**
 * Sends the request, shedding optional parameters the endpoint turns out not to support.
 *
 * Both retries are bounded by construction: each flag can only go from set to unset, so this
 * terminates after at most three attempts even if an endpoint rejects both.
 */
export async function streamChat(request: EvaChatRequest): Promise<void> {
	let temperature = request.temperature;
	let includeUsage = true;

	for (; ;) {
		try {
			await runOnce(request, temperature, includeUsage);
			return;
		} catch (err) {
			if (err instanceof RetryWithoutTemperature && temperature !== undefined) {
				temperature = undefined;
				continue;
			}
			if (err instanceof RetryWithoutStreamOptions && includeUsage) {
				includeUsage = false;
				continue;
			}
			if (isAbort(err, request.signal)) {
				return;
			}
			throw err;
		}
	}
}

async function runOnce(request: EvaChatRequest, temperature: number | undefined, includeUsage: boolean): Promise<void> {
	const url = `${trimSlash(request.baseUrl)}/chat/completions`;
	const tools = wireTools(request.tools);

	const body: Record<string, unknown> = {
		model: request.model,
		messages: toWireMessages(request.messages),
		stream: true,
		max_tokens: request.maxOutputTokens,
	};
	// Without this the gateway omits `usage` from every frame; with it we get real token counts
	// instead of having to estimate them. Omitted entirely when unsupported, rather than sent as
	// false, because a server that rejects the key is unlikely to accept the value either.
	if (includeUsage) {
		body.stream_options = { include_usage: true };
	}
	if (typeof temperature === 'number') {
		body.temperature = temperature;
	}
	if (tools) {
		body.tools = tools;
	}

	// Captured after the body is complete and before it is sent, so the log holds exactly what the
	// gateway receives. This is the only route the Chat view and agent sessions take to EVA.
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
		throw new Error(`连不上 EVA AI 网关（${url}）：${err instanceof Error ? err.message : String(err)}`);
	}

	if (!response.ok || !response.body) {
		const text = await response.text().catch(() => '');
		span?.fail(`HTTP ${response.status}：${text.slice(0, 300)}`, response.status);
		// A self-hosted endpoint reports an unsupported `stream_options` as an ordinary 400, so the
		// degradation has to be recognised here too and not only inside the 200 stream.
		if (includeUsage && mentionsStreamOptions(text)) {
			throw new RetryWithoutStreamOptions();
		}
		throw new Error(`EVA AI 网关返回 HTTP ${response.status}${response.status === 401 || response.status === 403 ? '（登录态已失效，请重新登录）' : ''}：${text.slice(0, 300)}`);
	}

	try {
		await readStream(response, request.handlers, temperature !== undefined, includeUsage, span);
		span?.finish(response.status);
	} catch (err) {
		span?.fail(err, response.status);
		throw err;
	}
}

function mentionsStreamOptions(text: string): boolean {
	return /stream_options|include_usage/i.test(text);
}

async function readStream(response: Response, handlers: EvaStreamHandlers, hadTemperature: boolean, includeUsage: boolean, span: EvaTraceSpan | undefined): Promise<void> {
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
					if (hadTemperature && /temperature/i.test(errorText)) {
						throw new RetryWithoutTemperature();
					}
					if (includeUsage && mentionsStreamOptions(errorText)) {
						throw new RetryWithoutStreamOptions();
					}
					throw new Error(`EVA AI 上游错误：${errorText}`);
				}

				if (frame?.usage) {
					handlers.onUsage?.(frame.usage);
					span?.noteUsage(frame.usage);
				}

				const choice = frame?.choices?.[0];
				if (!choice) {
					continue;
				}
				const delta = choice.delta ?? {};

				if (typeof delta.content === 'string' && delta.content) {
					handlers.onText(delta.content);
					span?.noteText(delta.content);
				}

				// Reasoning is not standardised across OpenAI-compatible gateways: DashScope/Qwen
				// send `reasoning_content`, others use `reasoning` or `reasoning_text`. Accept all of
				// them, otherwise the model's reasoning silently lands in the answer text.
				const thinking = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text;
				if (typeof thinking === 'string' && thinking) {
					handlers.onThinking(thinking);
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
					emitToolCalls(pending, handlers, span);
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
				emitToolCalls(pending, handlers, span);
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

export function toWireMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): WireMessage[] {
	const wire: WireMessage[] = [];

	for (const message of messages) {
		let text = '';
		const toolCalls: WireToolCall[] = [];
		const toolResults: WireMessage[] = [];

		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
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
			// LanguageModelDataPart has no representation: eva-ai models are text-only.
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

		if (text) {
			wire.push({ role: 'user', content: text });
		}
		wire.push(...toolResults);
	}

	return wire;
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
