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
		const path = url.pathname.replace(/\/+$/, '') || '/';

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
			const raw = await this._sendCollect(target, accessToken, upstreamBody);
			writeJson(res, 200, toMessagesResult(safeJson(raw), model));
			return;
		}

		const state = new MessageStreamState(model);
		await this._send(target, accessToken, upstreamBody, res, frame => state.takeOpenAIFrame(frame));
	}

	// #endregion

	// #region Transport

	private _send(
		target: URL,
		accessToken: string,
		body: unknown,
		res: http.ServerResponse,
		translate?: (frame: Record<string, unknown>) => string | undefined,
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
						const translated = requestToMessagesError(safeJson(raw));
						writeJson(res, status, translated);
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

	private _sendCollect(target: URL, accessToken: string, body: unknown): Promise<string> {
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
				void readBody(upstreamRes).then(resolve, reject);
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

// #region HTTP helpers

function isAuthorized(req: http.IncomingMessage, key: string): boolean {
	const header = req.headers.authorization;
	if (typeof header !== 'string') {
		return false;
	}
	// Anthropic's SDKs send `x-api-key`, OpenAIs send `Authorization`. Accept both.
	const bearer = header.startsWith('Bearer ') ? header.slice(7) : header;
	const alt = req.headers['x-api-key'];
	const candidate = bearer || (Array.isArray(alt) ? alt[0] : alt) || '';
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
