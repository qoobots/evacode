/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import type { EvaAuthService } from './evaAuth';
import { readConfig } from './evaConfig';

/**
 * Fixed by default rather than ephemeral: the CLI configurations we write carry this address and
 * are read back long after the window that wrote them closed, so an ephemeral port would strand
 * them on a dead endpoint at the next restart. Falling back to an ephemeral port beats failing
 * outright when the default is already taken.
 */
const DEFAULT_PROXY_PORT = 45877;
const PROXY_KEY_STORAGE_KEY = 'eva-ai.proxyKey';

export interface EvaProxyInfo {
	/** Loopback endpoint for external CLIs, e.g. `http://127.0.0.1:54321` — no trailing slash. */
	readonly baseUrl: string;
	/** Local bearer secret; external CLIs send it as `Authorization: Bearer <key>`. */
	readonly key: string;
}

/**
 * Local HTTP proxy that lets outside Agent CLIs reach EVA.
 *
 * It exists because those CLIs are built against their vendor's wire protocol and nothing else:
 * Claude Code speaks Anthropic Messages, Codex speaks OpenAI Responses/Chat, and neither can be
 * pointed at a raw OpenAI-compatible gateway without losing tool calling and streaming shape. The
 * proxy therefore keeps each CLI on its own protocol and translates at the edge, so every request
 * still ends as an OpenAI chat completion against EVA.
 *
 * Bound to loopback only, and guarded by a generated key, so a blinded/localhost-open process on
 * the same machine cannot silently spend the user's EVA quota.
 */
export class EvaLocalProxy implements vscode.Disposable {

	private _server: http.Server | undefined;
	private _starting: Promise<EvaProxyInfo> | undefined;
	private _info: EvaProxyInfo | undefined;

	/**
	 * Persisted across restarts. CLI configurations are written once and read back much later, so
	 * a key that changed on every launch would lock the CLI out with a 401 after any restart.
	 */
	private readonly _key: string;

	constructor(private readonly _auth: EvaAuthService, storage?: vscode.Memento) {
		const existing = storage?.get<string>(PROXY_KEY_STORAGE_KEY);
		if (existing) {
			this._key = existing;
			return;
		}
		this._key = randomBytes(24).toString('hex');
		void storage?.update(PROXY_KEY_STORAGE_KEY, this._key);
	}

	/** Endpoint details, once {@link start} has resolved. */
	get info(): EvaProxyInfo | undefined {
		return this._info;
	}

	/** Binds once; later calls share the same socket. */
	async start(): Promise<EvaProxyInfo> {
		if (!this._starting) {
			this._starting = this._start();
		}
		return this._starting;
	}

	private async _start(): Promise<EvaProxyInfo> {
		const server = http.createServer((req, res) => {
			void this._handle(req, res).catch(err => {
				writeJson(res, 500, { type: 'error', error: { type: 'api_error', message: errorMessage(err) } });
			});
		});
		await this._listen(server);
		this._server = server;
		const address = server.address();
		const port = (address && typeof address === 'object') ? address.port : 0;
		this._info = { baseUrl: `http://127.0.0.1:${port}`, key: this._key };
		return this._info;
	}

	private async _listen(server: http.Server): Promise<void> {
		try {
			await bind(server, DEFAULT_PROXY_PORT);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') {
				throw err;
			}
			await bind(server, 0);
		}
	}

	async stop(): Promise<void> {
		const server = this._server;
		this._server = undefined;
		this._starting = undefined;
		this._info = undefined;
		if (!server) {
			return;
		}
		await new Promise<void>(resolve => {
			// Do not wait for keep-alive sockets: external CLIs hold them open between turns.
			server.close(() => resolve());
			server.closeAllConnections();
		});
	}

	dispose(): void {
		void this.stop();
	}

	// #region Routing

	private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const path = (url.pathname.replace(/\/+$/, '').replace(/^\/+/, '/')) || '/';

		// Health stays unauthenticated so the CLIs can probe before we ever see a key.
		if (path === '/healthz' || path === '/health') {
			writeJson(res, 200, { status: 'ok' });
			return;
		}

		if (!isAuthorized(req, this._key)) {
			writeJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Invalid or missing proxy key.' } });
			return;
		}

		const accessToken = await this._auth.getAccessToken();
		if (!accessToken) {
			writeJson(res, 403, { type: 'error', error: { type: 'authentication_error', message: 'EVA is not signed in.' } });
			return;
		}
		const config = readConfig();

		if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
			await this._forwardJson(config, accessToken, '/models', res);
			return;
		}

		if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
			const raw = await readBody(req);
			await this._forwardChat(config, accessToken, safeJson(raw), res);
			return;
		}

		if (req.method === 'POST' && (path === '/v1/messages' || path === '/messages')) {
			const raw = await readBody(req);
			await this._answerMessages(config, accessToken, safeJson(raw), res);
			return;
		}

		if (req.method === 'POST' && (path === '/v1/responses' || path === '/responses')) {
			const raw = await readBody(req);
			await this._answerResponses(config, accessToken, safeJson(raw), res);
			return;
		}

		writeJson(res, 404, { type: 'error', error: { type: 'invalid_request_error', message: `Unsupported route: ${req.method} ${path}` } });
	}

	// #endregion

	// #region Upstream transport

	private async _forwardChat(config: { readonly aiBaseUrl: string; readonly temperature: number | undefined }, accessToken: string, request: Record<string, unknown>, res: http.ServerResponse): Promise<void> {
		// OpenAI clients already speak EVA's dialect; they only need the credentials swapped.
		// Republishing the upstream SSE frames verbatim keeps this route faithful by construction.
		const target = new URL('/chat/completions', ensureSlash(config.aiBaseUrl));
		await this._send(target, accessToken, toUpstreamChatRequest(config, request), res, undefined);
	}

	private async _forwardJson(config: { readonly aiBaseUrl: string }, accessToken: string, path: string, res: http.ServerResponse): Promise<void> {
		const target = new URL(path, ensureSlash(config.aiBaseUrl));
		const module = target.protocol === 'https:' ? https : http;
		await new Promise<void>((resolve, reject) => {
			const upstream = module.request(target, {
				method: 'GET',
				headers: { 'authorization': `Bearer ${accessToken}` },
			}, upstreamRes => {
				void readBody(upstreamRes).then(raw => {
					writeJsonRaw(res, upstreamRes.statusCode ?? 502, raw || '{}');
					resolve();
				}, reject);
			});
			upstream.on('error', reject);
			upstream.end();
		});
	}

	private async _answerMessages(config: { readonly aiBaseUrl: string; readonly temperature: number | undefined }, accessToken: string, request: Record<string, unknown>, res: http.ServerResponse): Promise<void> {
		const model = typeof request.model === 'string' ? request.model : 'eva';
		const upstreamBody = toChatRequestFromMessages(config, request);
		const target = new URL('/chat/completions', ensureSlash(config.aiBaseUrl));

		if (request.stream !== true) {
			const { status, body } = await this._sendCollect(target, accessToken, upstreamBody);
			if (status !== 200) {
				writeJson(res, status, requestToMessagesError(safeJson(body)));
				return;
			}
			writeJson(res, 200, toMessagesResult(safeJson(body), model));
			return;
		}

		const state = new MessageStreamState(model);
		await this._send(target, accessToken, upstreamBody, res, frame => state.takeOpenAIFrame(frame));
	}

	private async _answerResponses(config: { readonly aiBaseUrl: string; readonly temperature: number | undefined }, accessToken: string, request: Record<string, unknown>, res: http.ServerResponse): Promise<void> {
		const model = typeof request.model === 'string' ? request.model : 'eva';
		const upstreamBody = toChatRequestFromResponses(config, request);
		const target = new URL('/chat/completions', ensureSlash(config.aiBaseUrl));

		if (request.stream !== true) {
			const { status, body } = await this._sendCollect(target, accessToken, upstreamBody);
			if (status !== 200) {
				writeJson(res, status, requestToResponsesError(safeJson(body)));
				return;
			}
			writeJson(res, 200, toResponsesResult(safeJson(body), model));
			return;
		}

		const state = new ResponsesStreamState(model);
		await this._send(target, accessToken, upstreamBody, res, frame => state.takeOpenAIFrame(frame), requestToResponsesError);
	}

	// #endregion

	// #region Transport

	private _send(
		target: URL,
		accessToken: string,
		body: unknown,
		res: http.ServerResponse,
		translate?: (frame: Record<string, unknown>) => string | undefined,
		errorToDialect: (raw: Record<string, unknown>) => Record<string, unknown> = requestToMessagesError,
	): Promise<void> {
		const module = target.protocol === 'https:' ? https : http;
		const payload = JSON.stringify(body);

		return new Promise<void>((resolve, reject) => {
			const upstream = module.request(target, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': Buffer.byteLength(payload),
					'authorization': `Bearer ${accessToken}`,
					'accept': 'text/event-stream',
				},
			}, upstreamRes => {
				const status = upstreamRes.statusCode ?? 502;
				const isStream = upstreamRes.headers['content-type']?.includes('text/event-stream');

				if (isStream) {
					res.writeHead(status, {
						'content-type': 'text/event-stream',
						'cache-control': 'no-cache',
						'connection': 'keep-alive',
					});
					pipeSse(upstreamRes, res, translate, () => resolve());
					return;
				}

				void readBody(upstreamRes).then(raw => {
					if (translate) {
						// Upstream refused to stream (e.g. an error body); surface it in the
						// caller's dialect rather than leaking OpenAI's shape to a Messages client.
						writeJson(res, status, errorToDialect(safeJson(raw)));
					} else {
						writeJsonRaw(res, status, raw || '{}');
					}
					resolve();
				}, reject);
			});
			upstream.on('error', reject);
			upstream.end(payload);
		});
	}

	private _sendCollect(target: URL, accessToken: string, body: unknown): Promise<{ status: number; body: string }> {
		const module = target.protocol === 'https:' ? https : http;
		const payload = JSON.stringify(body);
		return new Promise((resolve, reject) => {
			const upstream = module.request(target, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': Buffer.byteLength(payload),
					'authorization': `Bearer ${accessToken}`,
				},
			}, upstreamRes => {
				void readBody(upstreamRes).then(raw => resolve({ status: upstreamRes.statusCode ?? 502, body: raw }), reject);
			});
			upstream.on('error', reject);
			upstream.end(payload);
		});
	}

	// #endregion
}

// #region Anthropic Messages ⇄ OpenAI chat

/**
 * Accumulates an OpenAI streaming reply and re-emits it as Anthropic Messages SSE frames, keeping
 * the incremental state that conversion needs: which content block is open, and whether the block
 * is text or a tool call (each tool call needs `input_json_delta` only, never `text_delta`).
 */
class MessageStreamState {

	private _started = false;
	private _nextIndex = 0;

	constructor(private readonly _model: string) { }

	/** Consumes one upstream frame and returns the SSE payload to write (if any). */
	takeOpenAIFrame(frame: Record<string, unknown>): string | undefined {
		const choices = frame.choices as Array<Record<string, unknown>> | undefined;
		const chunk = choices?.[0];
		const out: string[] = [];

		if (!this._started) {
			this._started = true;
			out.push(frameFor('message_start', {
				type: 'message_start',
				message: {
					id: `msg_${frame.id ?? 'eva'}`,
					type: 'message',
					role: 'assistant',
					model: this._model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			}));
		}

		const delta = chunk?.delta as Record<string, unknown> | undefined;
		if (delta) {
			const reasoning = delta.reasoning_content ?? delta.reasoning;
			if (typeof reasoning === 'string' && reasoning) {
				out.push(frameFor('content_block_delta', {
					type: 'content_block_delta',
					index: this._ensureThinking(out),
					delta: { type: 'thinking_delta', thinking: reasoning },
				}));
			}
			if (typeof delta.content === 'string' && delta.content) {
				out.push(frameFor('content_block_delta', {
					type: 'content_block_delta',
					index: this._ensureText(out),
					delta: { type: 'text_delta', text: delta.content },
				}));
			}
			for (const call of (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
				const openaiIndex = typeof call.index === 'number' ? call.index : 0;
				const id = String(call.id ?? `toolu_${openaiIndex}`);
				const name = String((call.function as Record<string, unknown> | undefined)?.name ?? '');
				const index = this._mapTool(out, openaiIndex, id, name);
				const args = (call.function as Record<string, unknown> | undefined)?.arguments;
				if (typeof args === 'string' && args) {
					out.push(frameFor('content_block_delta', {
						type: 'content_block_delta',
						index,
						delta: { type: 'input_json_delta', partial_json: args },
					}));
				}
			}
		}

		const finishReason = chunk?.finish_reason as string | null | undefined;
		if (finishReason) {
			out.push(...this._close());
			const usage = frame.usage as Record<string, number> | undefined;
			out.push(frameFor('message_delta', {
				type: 'message_delta',
				delta: { stop_reason: toAnthropicStopReason(finishReason), stop_sequence: null },
				usage: {
					input_tokens: usage?.prompt_tokens ?? 0,
					output_tokens: usage?.completion_tokens ?? 0,
				},
			}));
			out.push(frameFor('message_stop', { type: 'message_stop' }));
		}
		return out.length ? out.join('') : undefined;
	}

	private _textIndex: number | undefined;
	private _thinkingIndex: number | undefined;
	private readonly _toolBlocks = new Map<number, number>();

	private _ensureText(out: string[]): number {
		return this._textIndex ??= this._open(out, { type: 'text', text: '' });
	}

	private _ensureThinking(out: string[]): number {
		return this._thinkingIndex ??= this._open(out, { type: 'thinking', thinking: '' });
	}

	/**
	 * Anthropic block indexes must be contiguous from zero, while OpenAI tool indexes are an
	 * opaque per-stream sequence — so they are remapped rather than reused.
	 */
	private _mapTool(out: string[], openaiIndex: number, id: string, name: string): number {
		let index = this._toolBlocks.get(openaiIndex);
		if (index === undefined) {
			index = this._open(out, { type: 'tool_use', id, name, input: {} });
			this._toolBlocks.set(openaiIndex, index);
		}
		return index;
	}

	private _open(out: string[], block: Record<string, unknown>): number {
		const index = this._nextIndex++;
		out.push(frameFor('content_block_start', { type: 'content_block_start', index, content_block: block }));
		return index;
	}

	private _close(): string[] {
		const closing: string[] = [];
		if (this._thinkingIndex !== undefined) {
			closing.push(frameFor('content_block_stop', { type: 'content_block_stop', index: this._thinkingIndex }));
			this._thinkingIndex = undefined;
		}
		if (this._textIndex !== undefined) {
			closing.push(frameFor('content_block_stop', { type: 'content_block_stop', index: this._textIndex }));
			this._textIndex = undefined;
		}
		for (const index of this._toolBlocks.values()) {
			closing.push(frameFor('content_block_stop', { type: 'content_block_stop', index }));
		}
		this._toolBlocks.clear();
		return closing;
	}
}

/** Maps a Messages request onto EVA's OpenAI-compatible chat body. */
function toChatRequestFromMessages(config: { readonly temperature: number | undefined }, request: Record<string, unknown>): Record<string, unknown> {
	const messages: unknown[] = [];

	if (typeof request.system === 'string' && request.system) {
		messages.push({ role: 'system', content: request.system });
	} else if (Array.isArray(request.system)) {
		const text = (request.system as Array<Record<string, unknown>>)
			.filter(part => part.type === 'text')
			.map(part => String(part.text ?? ''))
			.join('');
		if (text) {
			messages.push({ role: 'system', content: text });
		}
	}

	for (const raw of (request.messages as Array<Record<string, unknown>> | undefined) ?? []) {
		const role = raw.role === 'assistant' ? 'assistant' : 'user';
		const toolCalls = extractToolCalls(raw.content);
		if (toolCalls.length) {
			messages.push({
				role: 'assistant',
				content: extractText(raw.content),
				tool_calls: toolCalls.map(call => ({
					id: call.id,
					type: 'function',
					function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
				})),
			});
			continue;
		}
		const toolResults = extractToolResults(raw.content);
		if (toolResults.length) {
			for (const result of toolResults) {
				messages.push({ role: 'tool', tool_call_id: result.tool_use_id, content: result.content });
			}
			continue;
		}
		messages.push({ role, content: toOpenAIContent(raw.content) });
	}

	return {
		...toUpstreamChatRequest(config, request),
		messages,
	};
}

function extractText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	return (Array.isArray(content) ? content as Array<Record<string, unknown>> : [])
		.filter(part => part.type === 'text' || part.type === 'thinking')
		.map(part => String(part.text ?? part.thinking ?? ''))
		.join('');
}

function extractToolCalls(content: unknown): Array<{ id: string; name: string; input?: unknown }> {
	const parts = Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
	return parts
		.filter(part => part.type === 'tool_use')
		.map(part => ({
			id: String(part.id ?? ''),
			name: String(part.name ?? ''),
			input: part.input,
		}));
}

function extractToolResults(content: unknown): Array<{ tool_use_id: string; content: string }> {
	const parts = Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
	return parts
		.filter(part => part.type === 'tool_result')
		.map(part => ({
			tool_use_id: String(part.tool_use_id ?? ''),
			content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? ''),
		}));
}

/** Preserves image blocks: EVA takes OpenAI's `image_url` shape, Anthropic sends raw base64. */
function toOpenAIContent(content: unknown): unknown {
	if (typeof content === 'string') {
		return content;
	}
	const parts = Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
	const mapped = parts
		.filter(part => part.type === 'text' || part.type === 'image')
		.map(part => {
			if (part.type === 'text') {
				return { type: 'text', text: String(part.text ?? '') };
			}
			const source = part.source as Record<string, unknown> | undefined;
			const data = source?.type === 'base64' ? `data:${source.media_type ?? 'image/png'};base64,${source.data ?? ''}` : undefined;
			return data ? { type: 'image_url', image_url: { url: data } } : undefined;
		})
		.filter(part => part !== undefined);
	return mapped.length === 1 && mapped[0].type === 'text' ? mapped[0].text : mapped;
}

function toUpstreamChatRequest(config: { readonly temperature: number | undefined }, request: Record<string, unknown>): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: request.model,
		stream: request.stream === true,
	};
	if (typeof request.max_tokens === 'number') {
		body.max_tokens = request.max_tokens;
	}
	const temperature = typeof request.temperature === 'number' ? request.temperature : config.temperature;
	if (temperature !== undefined) {
		body.temperature = temperature;
	}
	if (typeof request.top_p === 'number') {
		body.top_p = request.top_p;
	}
	if (Array.isArray(request.stop_sequences)) {
		body.stop = request.stop_sequences;
	}
	if (Array.isArray(request.tools)) {
		body.tools = (request.tools as Array<Record<string, unknown>>).map(tool => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.input_schema ?? { type: 'object', properties: {} },
			},
		}));
	}
	if (request.stream === true) {
		// Required for the usage totals Anthropic puts in its final `message_delta`.
		body.stream_options = { include_usage: true };
	}
	return body;
}

function toAnthropicStopReason(reason: string): string {
	switch (reason) {
		case 'length':
			return 'max_tokens';
		case 'tool_calls':
			return 'tool_use';
		case 'content_filter':
			return 'refusal';
		case 'stop_sequence':
			return 'stop_sequence';
		default:
			return 'end_turn';
	}
}

function frameFor(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Rewrites a buffered OpenAI chat completion as a non-streaming Anthropic Messages response. */
function toMessagesResult(raw: Record<string, unknown>, model: string): Record<string, unknown> {
	const choice = ((raw.choices as Array<Record<string, unknown>> | undefined) ?? [])[0];
	const message = choice?.message as Record<string, unknown> | undefined;
	const content: unknown[] = [];

	if (typeof message?.content === 'string' && message.content) {
		content.push({ type: 'text', text: message.content });
	}
	for (const call of (message?.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
		const fn = call.function as Record<string, unknown> | undefined;
		content.push({
			type: 'tool_use',
			id: String(call.id ?? ''),
			name: String(fn?.name ?? ''),
			input: parseToolArguments(fn?.arguments),
		});
	}

	const usage = raw.usage as Record<string, number> | undefined;
	return {
		id: `msg_${String(raw.id ?? 'eva')}`,
		type: 'message',
		role: 'assistant',
		model,
		content,
		stop_reason: toAnthropicStopReason(String(choice?.finish_reason ?? 'stop')),
		stop_sequence: null,
		usage: {
			input_tokens: usage?.prompt_tokens ?? 0,
			output_tokens: usage?.completion_tokens ?? 0,
		},
	};
}

/** Tool arguments travel as a JSON string in OpenAI land and as an object in Anthropic land. */
function parseToolArguments(raw: unknown): Record<string, unknown> {
	if (typeof raw === 'string') {
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
		} catch {
			return {};
		}
	}
	return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

/** Upstream refused to stream (usually an error body); keep it inside the client's dialect. */
function requestToMessagesError(raw: Record<string, unknown>): Record<string, unknown> {
	const error = raw.error as Record<string, unknown> | undefined;
	const message = typeof error?.message === 'string' ? error.message : 'Upstream request failed.';
	return { type: 'error', error: { type: 'api_error', message } };
}

// #endregion

// #region OpenAI chat ⇄ OpenAI Responses

/**
 * Accumulates an OpenAI streaming reply and re-emits it as OpenAI Responses SSE, the wire Codex
 * speaks natively. The event shape is heavier than Messages — every text span is a `message` output
 * item with a `content_part`, and each tool call is its own `function_call` output item with
 * `function_call_arguments` deltas — but the source stream is the same chat completion.
 */
class ResponsesStreamState {
	private _started = false;
	private _completed = false;
	private _responseId = '';
	private _messageOpen = false;
	private _messageItemId = '';
	private _text = '';
	private readonly _toolBlocks = new Map<number, { itemId: string; callId: string; name: string; args: string; outputIndex: number }>();
	private _toolNextIndex = 0;

	constructor(private readonly _model: string) { }

	takeOpenAIFrame(frame: Record<string, unknown>): string | undefined {
		const chunk = (frame.choices as Array<Record<string, unknown>> | undefined)?.[0];
		const out: string[] = [];

		if (!this._started) {
			this._started = true;
			this._responseId = `resp_${frame.id ?? 'eva'}`;
			out.push(frameFor('response.created', {
				type: 'response.created',
				response: { id: this._responseId, object: 'response', status: 'in_progress', model: this._model, output: [] },
			}));
		}

		const delta = chunk?.delta as Record<string, unknown> | undefined;
		if (delta) {
			const reasoning = delta.reasoning_content ?? delta.reasoning;
			if (typeof reasoning === 'string' && reasoning) {
				this._emitText(out, reasoning);
			}
			if (typeof delta.content === 'string' && delta.content) {
				this._emitText(out, delta.content);
			}
			for (const call of (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
				const openaiIndex = typeof call.index === 'number' ? call.index : 0;
				let tb = this._toolBlocks.get(openaiIndex);
				if (!tb) {
					this._finalizeMessage(out);
					const callId = String(call.id ?? `call_${openaiIndex}`);
					tb = {
						itemId: `fc_${callId}`,
						callId,
						name: String((call.function as Record<string, unknown> | undefined)?.name ?? ''),
						args: '',
						outputIndex: (this._messageOpen ? 1 : 0) + this._toolNextIndex++,
					};
					this._toolBlocks.set(openaiIndex, tb);
					out.push(frameFor('response.output_item.added', {
						type: 'response.output_item.added',
						output_index: tb.outputIndex,
						item: { id: tb.itemId, type: 'function_call', status: 'in_progress', call_id: tb.callId, name: tb.name, arguments: '' },
					}));
				}
				const args = (call.function as Record<string, unknown> | undefined)?.arguments;
				if (typeof args === 'string' && args) {
					tb.args += args;
					out.push(frameFor('response.function_call_arguments.delta', {
						type: 'response.function_call_arguments.delta',
						item_id: tb.itemId,
						output_index: tb.outputIndex,
						delta: args,
					}));
				}
			}
		}

		const finishReason = chunk?.finish_reason as string | null | undefined;
		if (finishReason) {
			this._finalize(frame, out);
		} else if (frame.usage && !this._completed) {
			// `include_usage` emits the token totals in a trailing chunk carrying no finish_reason;
			// its arrival is what seals the response when the model ended without a distinct stop.
			this._finalize(frame, out);
		}
		return out.length ? out.join('') : undefined;
	}

	private _emitText(out: string[], text: string): void {
		if (!this._messageOpen) {
			this._messageItemId = `msg_${Math.random().toString(36).slice(2, 12)}`;
			this._messageOpen = true;
			out.push(frameFor('response.output_item.added', {
				type: 'response.output_item.added',
				output_index: 0,
				item: { id: this._messageItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
			}));
			out.push(frameFor('response.content_part.added', {
				type: 'response.content_part.added',
				item_id: this._messageItemId,
				output_index: 0,
				content_index: 0,
				part: { type: 'output_text', text: '', annotations: [] },
			}));
		}
		this._text += text;
		out.push(frameFor('response.output_text.delta', {
			type: 'response.output_text.delta',
			item_id: this._messageItemId,
			output_index: 0,
			content_index: 0,
			delta: text,
		}));
	}

	private _finalizeMessage(out: string[]): void {
		if (!this._messageOpen) {
			return;
		}
		const text = this._text;
		this._messageOpen = false;
		out.push(frameFor('response.output_text.done', {
			type: 'response.output_text.done',
			item_id: this._messageItemId,
			output_index: 0,
			content_index: 0,
			text,
		}));
		out.push(frameFor('response.content_part.done', {
			type: 'response.content_part.done',
			item_id: this._messageItemId,
			output_index: 0,
			content_index: 0,
			part: { type: 'output_text', text, annotations: [] },
		}));
		out.push(frameFor('response.output_item.done', {
			type: 'response.output_item.done',
			output_index: 0,
			item: { id: this._messageItemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] },
		}));
	}

	private _finalize(frame: Record<string, unknown>, out: string[]): void {
		if (this._completed) {
			return;
		}
		this._completed = true;
		this._finalizeMessage(out);
		for (const tb of this._toolBlocks.values()) {
			out.push(frameFor('response.function_call_arguments.done', {
				type: 'response.function_call_arguments.done',
				item_id: tb.itemId,
				output_index: tb.outputIndex,
				arguments: tb.args,
			}));
			out.push(frameFor('response.output_item.done', {
				type: 'response.output_item.done',
				output_index: tb.outputIndex,
				item: { id: tb.itemId, type: 'function_call', status: 'completed', call_id: tb.callId, name: tb.name, arguments: tb.args },
			}));
		}
		const usage = frame.usage as Record<string, number> | undefined;
		out.push(frameFor('response.completed', {
			type: 'response.completed',
			response: {
				id: this._responseId,
				object: 'response',
				status: 'completed',
				model: this._model,
				output: this._buildOutput(),
				usage: { input_tokens: usage?.prompt_tokens ?? 0, output_tokens: usage?.completion_tokens ?? 0 },
			},
		}));
	}

	private _buildOutput(): Array<Record<string, unknown>> {
		const output: Array<Record<string, unknown>> = [];
		if (this._text !== '') {
			output.push({
				id: this._messageItemId,
				type: 'message',
				status: 'completed',
				role: 'assistant',
				content: [{ type: 'output_text', text: this._text, annotations: [] }],
			});
		}
		for (const tb of this._toolBlocks.values()) {
			output.push({
				id: tb.itemId,
				type: 'function_call',
				status: 'completed',
				call_id: tb.callId,
				name: tb.name,
				arguments: tb.args,
			});
		}
		if (output.length === 0) {
			output.push({
				id: this._messageItemId || `msg_${Math.random().toString(36).slice(2, 12)}`,
				type: 'message',
				status: 'completed',
				role: 'assistant',
				content: [{ type: 'output_text', text: '', annotations: [] }],
			});
		}
		return output;
	}
}

/** Maps an OpenAI Responses request onto EVA's chat completion body. */
function toChatRequestFromResponses(config: { readonly temperature: number | undefined }, request: Record<string, unknown>): Record<string, unknown> {
	const messages = responsesInputToMessages(request.input);
	if (typeof request.instructions === 'string' && request.instructions) {
		messages.unshift({ role: 'system', content: request.instructions });
	}
	const body = toUpstreamChatRequest(config, request);
	body.messages = messages;
	if (Array.isArray(request.tools)) {
		body.tools = responsesToolsToChat(request.tools);
	}
	if (typeof request.max_output_tokens === 'number') {
		body.max_tokens = request.max_output_tokens;
	}
	if (request.tool_choice === 'required') {
		body.tool_choice = 'required';
	}
	return body;
}

function responsesInputToMessages(input: unknown): Array<Record<string, unknown>> {
	if (typeof input === 'string') {
		return [{ role: 'user', content: input }];
	}
	const items = Array.isArray(input) ? input as Array<Record<string, unknown>> : [];
	const messages: Array<Record<string, unknown>> = [];
	let pendingToolCalls: Array<Record<string, unknown>> = [];

	const flushAssistant = (content: string): void => {
		if (pendingToolCalls.length) {
			messages.push({ role: 'assistant', content: content || '', tool_calls: pendingToolCalls });
			pendingToolCalls = [];
		} else if (content) {
			messages.push({ role: 'assistant', content });
		}
	};

	for (const item of items) {
		const type = item.type;
		if (type === 'function_call') {
			pendingToolCalls.push({
				id: String(item.call_id ?? ''),
				type: 'function',
				function: { name: String(item.name ?? ''), arguments: typeof item.arguments === 'string' ? item.arguments : '' },
			});
			continue;
		}
		if (type === 'function_call_output') {
			flushAssistant('');
			messages.push({
				role: 'tool',
				tool_call_id: String(item.call_id ?? ''),
				content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
			});
			continue;
		}
		if (type === 'message' || item.role) {
			const role = String(item.role ?? 'user');
			const content = responsesContentToText(item.content);
			if (role === 'assistant') {
				const calls = responsesAssistantToolCalls(item.content);
				if (calls.length) {
					messages.push({ role: 'assistant', content: content || '', tool_calls: calls });
				} else {
					messages.push({ role: 'assistant', content: content || '' });
				}
			} else {
				messages.push({ role, content });
			}
		}
	}
	flushAssistant('');
	return messages;
}

function responsesContentToText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	const parts = Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
	return parts
		.filter(part => part.type === 'output_text' || part.type === 'input_text' || part.type === 'text')
		.map(part => String(part.text ?? ''))
		.join('');
}

function responsesAssistantToolCalls(content: unknown): Array<Record<string, unknown>> {
	const parts = Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
	return parts
		.filter(part => part.type === 'function_call')
		.map(part => ({
			id: String(part.call_id ?? part.id ?? ''),
			type: 'function',
			function: { name: String(part.name ?? ''), arguments: typeof part.arguments === 'string' ? part.arguments : '' },
		}));
}

function responsesToolsToChat(tools: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(tools)) {
		return [];
	}
	return (tools as Array<Record<string, unknown>>).map(tool => ({
		type: 'function',
		function: {
			name: String(tool.name ?? ''),
			description: typeof tool.description === 'string' ? tool.description : '',
			parameters: tool.parameters ?? { type: 'object', properties: {} },
		},
	}));
}

/** Rewrites a buffered chat completion as a non-streaming Responses result. */
function toResponsesResult(raw: Record<string, unknown>, model: string): Record<string, unknown> {
	const choice = ((raw.choices as Array<Record<string, unknown>> | undefined) ?? [])[0];
	const message = choice?.message as Record<string, unknown> | undefined;
	const text = typeof message?.content === 'string' ? message.content : '';
	const output: Array<Record<string, unknown>> = [];
	if (text) {
		output.push({
			id: `msg_${String(raw.id ?? 'eva')}`,
			type: 'message',
			status: 'completed',
			role: 'assistant',
			content: [{ type: 'output_text', text, annotations: [] }],
		});
	}
	for (const call of (message?.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
		const fn = call.function as Record<string, unknown> | undefined;
		output.push({
			id: `fc_${String(call.id ?? '')}`,
			call_id: String(call.id ?? ''),
			type: 'function_call',
			status: 'completed',
			name: String(fn?.name ?? ''),
			arguments: typeof fn?.arguments === 'string' ? fn.arguments : '',
		});
	}
	const usage = raw.usage as Record<string, number> | undefined;
	const responseOutput = text || output.length
		? output
		: [{ id: `msg_${String(raw.id ?? 'eva')}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] }];
	return {
		id: `resp_${String(raw.id ?? 'eva')}`,
		object: 'response',
		created_at: Math.floor(Date.now() / 1000),
		status: 'completed',
		model,
		output: responseOutput,
		usage: {
			input_tokens: usage?.prompt_tokens ?? 0,
			output_tokens: usage?.completion_tokens ?? 0,
			total_tokens: usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
		},
	};
}

/** Upstream refused to stream; surface it in the Responses dialect. */
function requestToResponsesError(raw: Record<string, unknown>): Record<string, unknown> {
	const error = raw.error as Record<string, unknown> | undefined;
	const message = typeof error?.message === 'string' ? error.message : 'Upstream request failed.';
	return { object: 'error', error: { type: 'api_error', message } };
}

// #endregion

// #region HTTP helpers

function isAuthorized(req: http.IncomingMessage, key: string): boolean {
	// Anthropic's SDKs authenticate with `x-api-key` and send no `Authorization` at all, while
	// OpenAI's SDKs do the reverse — so either one alone has to be enough.
	const authorization = req.headers.authorization;
	const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ')
		? authorization.slice(7)
		: authorization;
	const apiKey = req.headers['x-api-key'];
	const candidate = (typeof bearer === 'string' ? bearer : '')
		|| (Array.isArray(apiKey) ? apiKey[0] : apiKey)
		|| '';
	return candidate === key;
}

function bind(server: http.Server, port: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onError = (err: Error): void => {
			server.removeListener('error', onError);
			reject(err);
		};
		server.once('error', onError);
		server.listen(port, '127.0.0.1', () => {
			server.removeListener('error', onError);
			resolve();
		});
	});
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const parts: Buffer[] = [];
		req.on('data', chunk => parts.push(chunk as Buffer));
		req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
		req.on('error', reject);
	});
}

function safeJson(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw || '{}');
		return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
	writeJsonRaw(res, status, JSON.stringify(body));
}

function writeJsonRaw(res: http.ServerResponse, status: number, raw: string): void {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(raw);
}

/** Splits upstream SSE into frames and writes each translated frame downstream on arrival. */
function pipeSse(
	source: http.IncomingMessage,
	target: http.ServerResponse,
	translate: ((chunk: Record<string, unknown>) => string | undefined) | undefined,
	onEnd: () => void,
): void {
	let buffer = '';
	source.setEncoding('utf8');
	source.on('data', piece => {
		buffer += piece as string;
		let split: number;
		while ((split = buffer.indexOf('\n\n')) >= 0) {
			const frame = buffer.slice(0, split);
			buffer = buffer.slice(split + 2);
			if (!translate) {
				// OpenAI-native client: republish untouched so we add no behavioural drift.
				target.write(`${frame}\n\n`);
				continue;
			}
			const parsed = parseSseFrame(frame);
			if (!parsed) {
				continue;
			}
			const translated = translate(parsed);
			if (translated) {
				target.write(translated);
			}
		}
	});
	source.on('end', () => {
		target.end();
		onEnd();
	});
	source.on('error', () => {
		target.end();
		onEnd();
	});
}

function parseSseFrame(frame: string): Record<string, unknown> | undefined {
	for (const line of frame.split('\n')) {
		if (!line.startsWith('data:')) {
			continue;
		}
		const data = line.slice(5).trim();
		if (!data || data === '[DONE]') {
			return undefined;
		}
		try {
			return JSON.parse(data) as Record<string, unknown>;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function ensureSlash(base: string): string {
	return base.endsWith('/') ? base : `${base}/`;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// #endregion
