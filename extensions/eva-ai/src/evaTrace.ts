/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See the License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Writes one JSON file per model interaction, for inspecting the context we send and the answers
 * we get back.
 *
 * Every route to EVA ends in one of two places — the language model provider in evaChat.ts (the
 * Chat view and agent sessions, which is what the Copilot extension asks `vscode.lm` for) and the
 * local proxy in evaProxy.ts (Claude Code on `/v1/messages`, Codex on `/v1/responses`). Both are
 * instrumented through this module, so the log covers all three clients from one setting.
 *
 * Three properties matter for the analysis this exists for:
 *
 *  - **The request is what went on the wire, not what the client sent us.** For the CLI routes the
 *    two differ (Anthropic's `system`/`tool_use` blocks become OpenAI `messages`/`tool_calls`), and
 *    the upstream shape is the one that decides the context the model actually sees. The client's
 *    own body is kept alongside as `clientRequest` when it differs.
 *
 *  - **Streamed replies are reassembled.** Recording the frames verbatim would leave the answer
 *    fragmented across hundreds of deltas, which is unusable: the text is concatenated, tool call
 *    arguments are concatenated per index (they arrive in fragments), and the final `usage` is kept.
 *
 *  - **Secrets never reach the file.** The access token and the proxy key travel in headers, which
 *    are not logged at all, and any field whose name looks like a credential is redacted on the
 *    way out — the bodies come from third-party CLIs we do not control.
 *
 * Off unless `eva-ai.trace.enabled` is set: the log holds the user's source code verbatim.
 */

/**
 * Which caller produced a record, used in the file name.
 *
 * The four named values are the known routes; the open-ended member is what lets a BYOK model source
 * be recorded under its own id instead of being flattened into one of them - a source configured in
 * settings has no predetermined name.
 */
export type EvaTraceSource = 'copilot' | 'claude-code' | 'codex' | 'openai' | (string & {});

export interface EvaTraceConfig {
	readonly enabled: boolean;
	readonly directory: string;
	/**
	 * Per-field cap, applied when writing. One agent turn can legitimately be hundreds of
	 * kilobytes, so the default is generous; the cap only exists so a pathological payload cannot
	 * write gigabytes to the user's disk.
	 */
	readonly maxChars: number;
}

export interface EvaTraceBegin {
	readonly source: EvaTraceSource;
	/** Route as the caller saw it, e.g. `POST /v1/messages`. */
	readonly route?: string;
	/** Upstream URL the request was sent to. */
	readonly url?: string;
	readonly model?: string;
	/**
	 * The body sent upstream to EVA. Optional because the proxy routes decide to log before they
	 * have translated the client's request into it — `_send` and `_sendCollect` fill it in with the
	 * payload they actually put on the wire.
	 */
	readonly request?: unknown;
	/** The client's own body, when it differs from `request`. */
	readonly clientRequest?: unknown;
}

export interface EvaTraceSpan {
	noteText(text: string, kind?: 'text' | 'thinking'): void;
	noteToolCall(calls: readonly { readonly id: string; readonly name: string; readonly arguments: string }[]): void;
	noteUsage(usage: unknown): void;
	/** One upstream chunk, in the OpenAI chat dialect (also what the proxy receives). */
	noteOpenAIFrame(frame: Record<string, unknown>): void;
	/** A complete, buffered upstream reply — the non-streaming case. */
	noteRawResponse(body: string): void;
	fail(error: unknown, status?: number): void;
	finish(status?: number): void;
}

const DEFAULT_MAX_CHARS = 1_000_000;
const SETTINGS = 'eva-ai';

/** Anything whose name looks like a credential is dropped before the record is written. */
const SENSITIVE_KEY = /^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|proxy[-_]?key)$/i;
const REDACTED = '<redacted>';

let defaultDirectory: string | undefined;
let logger: ((line: string) => void) | undefined;
let sequence = 0;

/**
 * Where records go when `eva-ai.trace.directory` is unset. The provider and the proxy both log
 * from code paths that never see the extension context, so the global-storage path is captured
 * once at activation rather than threaded through every call.
 */
export function setTraceDirectory(directory: string): void {
	defaultDirectory = directory;
}

/** Where write failures surface. Loud enough to notice, never thrown into a request. */
export function setTraceLogger(fn: ((line: string) => void) | undefined): void {
	logger = fn;
}

export function readTraceConfig(): EvaTraceConfig {
	const section = vscode.workspace.getConfiguration(SETTINGS);
	const configured = section.get<string>('trace.directory');
	const directory = typeof configured === 'string' && configured.trim()
		? configured.trim()
		: path.join(defaultDirectory ?? os.tmpdir(), 'eva-ai-trace');
	const maxChars = section.get<number>('trace.maxChars');
	return {
		enabled: section.get<boolean>('trace.enabled') === true,
		directory,
		maxChars: typeof maxChars === 'number' && maxChars > 0 ? maxChars : DEFAULT_MAX_CHARS,
	};
}

/** Returns `undefined` when tracing is off, so callers can write `span?.…` with no branch. */
export function beginTrace(config: EvaTraceConfig, begin: EvaTraceBegin): EvaTraceSpan | undefined {
	if (!config.enabled) {
		return undefined;
	}
	return new TraceSpan(config, begin);
}

class TraceSpan implements EvaTraceSpan {

	private readonly startedAt = Date.now();
	/**
	 * Claimed once per record, not read again at write time: two requests of the same source can
	 * finish inside the same millisecond, and a counter sampled when the file is written would give
	 * them the same name and let the second overwrite the first.
	 */
	private readonly serial = ++sequence;
	private readonly id: string;
	private readonly streamedToolCalls = new Map<number, { id: string; name: string; args: string }>();
	private readonly toolCalls: Array<{ id: string; name: string; args: string }> = [];
	private text = '';
	private thinking = '';
	private usage: unknown;
	private raw: unknown;
	private error: string | undefined;
	private finished = false;

	constructor(
		private readonly config: EvaTraceConfig,
		private readonly begin: EvaTraceBegin,
	) {
		this.id = `${new Date().toISOString()}#${this.serial}`;
	}

	noteText(text: string, kind: 'text' | 'thinking' = 'text'): void {
		if (kind === 'thinking') {
			this.thinking += text;
		} else {
			this.text += text;
		}
	}

	noteToolCall(calls: readonly { readonly id: string; readonly name: string; readonly arguments: string }[]): void {
		for (const call of calls) {
			this.toolCalls.push({ id: call.id, name: call.name, args: call.arguments });
		}
	}

	noteUsage(usage: unknown): void {
		if (usage && typeof usage === 'object') {
			this.usage = usage;
		}
	}

	noteOpenAIFrame(frame: Record<string, unknown>): void {
		if (frame.usage) {
			this.noteUsage(frame.usage);
		}
		const chunk = (frame.choices as Array<Record<string, unknown>> | undefined)?.[0];
		const delta = chunk?.delta as Record<string, unknown> | undefined;
		if (!delta) {
			return;
		}
		const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text;
		if (typeof reasoning === 'string' && reasoning) {
			this.thinking += reasoning;
		}
		if (typeof delta.content === 'string' && delta.content) {
			this.text += delta.content;
		}
		for (const fragment of (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
			const index = Number(fragment.index ?? 0);
			const fn = fragment.function as Record<string, unknown> | undefined;
			const current = this.streamedToolCalls.get(index) ?? { id: '', name: '', args: '' };
			if (typeof fragment.id === 'string' && fragment.id) {
				current.id = fragment.id;
			}
			if (typeof fn?.name === 'string' && fn.name) {
				current.name = fn.name;
			}
			if (typeof fn?.arguments === 'string') {
				current.args += fn.arguments;
			}
			this.streamedToolCalls.set(index, current);
		}
	}

	noteRawResponse(body: string): void {
		const parsed = safeJson(body);
		if (!parsed) {
			return;
		}
		const choice = (parsed.choices as Array<Record<string, unknown>> | undefined)?.[0];
		if (!choice) {
			// Not a chat completion: an error body, or something else the gateway answered with.
			this.raw = parsed;
			return;
		}
		const message = choice.message as Record<string, unknown> | undefined;
		if (typeof message?.content === 'string' && message.content) {
			this.text += message.content;
		}
		const reasoning = message?.reasoning_content ?? message?.reasoning;
		if (typeof reasoning === 'string' && reasoning) {
			this.thinking += reasoning;
		}
		for (const call of (message?.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
			const fn = call.function as Record<string, unknown> | undefined;
			this.noteToolCall([{
				id: String(call.id ?? ''),
				name: String(fn?.name ?? ''),
				arguments: typeof fn?.arguments === 'string' ? fn.arguments : '',
			}]);
		}
		if (parsed.usage) {
			this.noteUsage(parsed.usage);
		}
	}

	fail(error: unknown, status?: number): void {
		this.error = error instanceof Error ? error.message : String(error);
		this.finish(status);
	}

	finish(status?: number): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		void this.write(status);
	}

	private async write(status?: number): Promise<void> {
		const max = this.config.maxChars;
		const now = new Date();
		try {
			const directory = path.join(this.config.directory, now.toISOString().slice(0, 10));
			await fs.promises.mkdir(directory, { recursive: true });
			const file = path.join(directory, `${fileName(now, this.begin.source, this.serial)}.json`);
			await fs.promises.writeFile(file, JSON.stringify(this.record(status, max), undefined, 2), 'utf8');
		} catch (err) {
			logger?.(`交互日志写入失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private record(status: number | undefined, max: number): Record<string, unknown> {
		const response: Record<string, unknown> = {
			textChars: this.text.length,
			text: cap(this.text, max),
		};
		if (this.thinking) {
			response.thinking = cap(this.thinking, max);
		}
		const toolCalls = [...this.toolCalls, ...[...this.streamedToolCalls.values()].filter(call => call.name || call.id)];
		if (toolCalls.length) {
			response.toolCalls = toolCalls.map(call => ({
				id: call.id,
				name: call.name,
				arguments: cap(call.args, max),
			}));
		}
		if (this.usage) {
			response.usage = this.usage;
		}
		if (this.raw) {
			response.raw = clamp(scrub(this.raw), max);
		}

		const record: Record<string, unknown> = {
			id: this.id,
			ts: new Date().toISOString(),
			source: this.begin.source,
			route: this.begin.route,
			upstream: this.begin.url,
			model: this.begin.model,
			durationMs: Date.now() - this.startedAt,
			status,
			request: clamp(scrub(this.begin.request), max),
		};
		const summary = summarize(this.begin.request);
		if (summary) {
			record.requestSummary = summary;
		}
		if (this.begin.clientRequest) {
			record.clientRequest = clamp(scrub(this.begin.clientRequest), max);
		}
		record.response = response;
		if (this.error) {
			record.error = this.error;
		}
		return record;
	}
}

/**
 * Per-message sizes of the prompt: the view that shows where the context actually goes, which is
 * the whole point of keeping this log — a 40 KB tool result or a system prompt repeated on every
 * turn is invisible in the raw body and obvious here.
 */
function summarize(request: unknown): Record<string, unknown> | undefined {
	const body = request as Record<string, unknown> | undefined;
	const messages = body?.messages;
	if (!Array.isArray(messages)) {
		return undefined;
	}
	const items = messages.map((message, index) => ({
		index,
		role: (message as Record<string, unknown>)?.role ?? '?',
		chars: JSON.stringify(message)?.length ?? 0,
	}));
	const tools = body?.tools;
	return {
		messageCount: items.length,
		totalChars: items.reduce((sum, item) => sum + item.chars, 0),
		toolCount: Array.isArray(tools) ? tools.length : 0,
		messages: items,
	};
}

function scrub(value: unknown, depth = 0): unknown {
	if (value === null || typeof value !== 'object' || depth > 12) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(entry => scrub(entry, depth + 1));
	}
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrub(entry, depth + 1);
	}
	return out;
}

function clamp(value: unknown, max: number, depth = 0): unknown {
	if (typeof value === 'string') {
		return cap(value, max);
	}
	if (value === null || typeof value !== 'object' || depth > 24) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(entry => clamp(entry, max, depth + 1));
	}
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		out[key] = clamp(entry, max, depth + 1);
	}
	return out;
}

function cap(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…[truncated ${text.length - max} chars]` : text;
}

/** Sortable by time, and unique per record: the serial is what keeps same-millisecond writes apart. */
function fileName(now: Date, source: string, serial: number): string {
	const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	// A source id can now come from settings, so it is not guaranteed to be a safe file name.
	const safe = source.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
	return `${time}-${String(now.getMilliseconds()).padStart(3, '0')}-${safe}-${String(serial).padStart(3, '0')}`;
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

function safeJson(raw: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(raw || '{}');
		return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}
