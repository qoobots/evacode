/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { EvaProxyInfo } from './evaProxy';

/** sibling copy kept next to each file we rewrite, so `restore` has something to put back. */
const BACKUP_SUFFIX = '.eva-backup';

export interface EvaCliTarget {
	readonly id: 'claudeCode' | 'codex';
	/** Absolute path of the file this target manages. */
	readonly file: string;
}

export function cliTargets(): readonly EvaCliTarget[] {
	return [
		{ id: 'claudeCode', file: path.join(os.homedir(), '.claude', 'settings.json') },
		{ id: 'codex', file: path.join(os.homedir(), '.codex', 'config.toml') },
	];
}

/**
 * Points an external Agent CLI at the local proxy.
 *
 * Both targets are edited in place rather than regenerated from scratch: these files carry the
 * user's own settings (plugins, MCP servers, marketplace paths, project trust levels) that we must
 * not disturb, and TOML carries comments we cannot round-trip through a parser we do not have. So
 * Claude's JSON is patched key-by-key, and Codex's TOML is patched by locating section headers and
 * replacing only the span they own.
 *
 * The previous contents are copied to `<file>.eva-backup` first, and only one generation of backup
 * is kept — applying twice in a row is safe because each run backs up what is there now.
 */
export interface CliModelSlots {
	/** Primary model: runs the main loop and is what the picker shows as Sonnet. */
	readonly main: string;
	/** Heavier tier, offered so switching up stays inside EVA. */
	readonly opus: string;
	/** Background tier (titles, summaries) — deliberately the cheapest the gateway offers. */
	readonly haiku: string;
	/** Spare tier; Claude Code renders one entry per tier, so it needs a value of its own. */
	readonly fable: string;
}

export async function applyCliConfig(target: EvaCliTarget, proxy: EvaProxyInfo, models: CliModelSlots): Promise<void> {
	await backup(target.file);
	switch (target.id) {
		case 'claudeCode':
			await applyToClaudeCode(target.file, proxy, models);
			return;
		case 'codex':
			await applyToCodex(target.file, proxy, models.main);
			return;
	}
}

export async function hasCliBackup(target: EvaCliTarget): Promise<boolean> {
	return fileExists(target.file + BACKUP_SUFFIX);
}

/** Restores `<file>` from its backup and drops the backup. False when there was nothing to undo. */
export async function restoreCliConfig(target: EvaCliTarget): Promise<boolean> {
	const backupFile = target.file + BACKUP_SUFFIX;
	if (!await fileExists(backupFile)) {
		return false;
	}
	await fs.copyFile(backupFile, target.file);
	await fs.unlink(backupFile);
	return true;
}

// #region Claude Code — ~/.claude/settings.json

async function applyToClaudeCode(file: string, proxy: EvaProxyInfo, models: CliModelSlots): Promise<void> {
	const settings = await readJsonFile(file);

	// Claude Code reads its endpoint and its model tiers from the environment. Leaving any tier
	// pointing at a foreign model would send part of the session — subagents, background
	// summarisation — back out to another vendor, so all of them are rewritten together. Each tier
	// gets its own model: they are independent slots the picker renders as separate entries, so
	// filling them all with one id offers four identical choices and makes the haiku tier — which
	// runs the background work — as expensive as the main loop.
	const env = (isRecord(settings.env) ? { ...settings.env } : {}) as Record<string, unknown>;
	env.ANTHROPIC_BASE_URL = proxy.baseUrl;
	env.ANTHROPIC_AUTH_TOKEN = proxy.key;
	env.ANTHROPIC_MODEL = models.main;
	env.ANTHROPIC_DEFAULT_SONNET_MODEL = models.main;
	env.ANTHROPIC_DEFAULT_OPUS_MODEL = models.opus;
	env.ANTHROPIC_DEFAULT_HAIKU_MODEL = models.haiku;
	env.ANTHROPIC_DEFAULT_FABLE_MODEL = models.fable;
	// The *_NAME siblings are what Claude Code shows in its own model UI; leaving them pointing at
	// the previous vendor would display a model the session never actually calls.
	env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = models.main;
	env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = models.opus;
	env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = models.haiku;
	env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME = models.fable;
	env.CLAUDE_CODE_SUBAGENT_MODEL = models.main;
	settings.env = env;
	settings.model = models.main;

	await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

// #endregion

// #region Codex — ~/.codex/config.toml

const CODEX_PROVIDER_NAME = 'eva';

async function applyToCodex(file: string, proxy: EvaProxyInfo, model: string): Promise<void> {
	const original = await readTextFile(file);

	const providerBlock = [
		`[model_providers.${CODEX_PROVIDER_NAME}]`,
		`name = "EVA"`,
		`base_url = "${proxy.baseUrl}/v1"`,
		// The proxy terminates the Responses wire now, so Codex stays on its native protocol
		// (which carries reasoning summaries Codex expects) rather than the chat translation.
		`wire_api = "responses"`,
		`requires_openai_auth = false`,
		`experimental_bearer_token = "${proxy.key}"`,
		'',
	].join('\n');

	const withTopLevel = replaceTopLevelKey(replaceTopLevelKey(replaceTopLevelKey(original, 'model_provider', CODEX_PROVIDER_NAME), 'model', model), 'model_reasoning_effort', undefined);
	const withProvider = replaceSection(withTopLevel, `[model_providers.${CODEX_PROVIDER_NAME}]`, providerBlock);
	const next = withProvider ?? `${withTopLevel.replace(/\s*$/, '')}\n\n${providerBlock}`;

	await fs.writeFile(file, next, 'utf8');
}

/**
 * Rewrites a scalar key that belongs to the file's top level, i.e. before the first `[section]`.
 * `value === undefined` removes the key, which is how `model_reasoning_effort` stops being sent to
 * a gateway that has no opinion about it.
 */
function replaceTopLevelKey(text: string, key: string, value: string | undefined): string {
	const lines = text.split('\n');
	let boundary = lines.findIndex(line => /^\s*\[/.test(line));
	if (boundary < 0) {
		boundary = lines.length;
	}
	const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
	const index = lines.findIndex((line, i) => i < boundary && pattern.test(line));

	if (index < 0) {
		return value === undefined ? text : `${lines.slice(0, boundary).join('\n')}\n${key} = ${quote(value)}${boundary >= lines.length ? '\n' : ''}${lines.slice(boundary).join('\n')}`;
	}
	const replacement = value === undefined ? [] : [`${key} = ${quote(value)}`];
	return [...lines.slice(0, index), ...replacement, ...lines.slice(index + 1)].join('\n');
}

/** Replaces a `[section]` block with `block`, retaining every byte outside that span. */
function replaceSection(text: string, header: string, block: string): string | undefined {
	const lines = text.split('\n');
	const start = lines.findIndex(line => line.trim() === header);
	if (start < 0) {
		return undefined;
	}
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^\s*\[/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return [...lines.slice(0, start), block, ...lines.slice(end)].join('\n');
}

function quote(value: string): string {
	return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

// #endregion

// #region Files

async function backup(file: string): Promise<void> {
	if (!await fileExists(file)) {
		return;
	}
	await fs.copyFile(file, file + BACKUP_SUFFIX);
}

async function fileExists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

async function readTextFile(file: string): Promise<string> {
	try {
		return await fs.readFile(file, 'utf8');
	} catch {
		return '';
	}
}

async function readJsonFile(file: string): Promise<Record<string, unknown>> {
	const raw = await readTextFile(file);
	if (!raw.trim()) {
		return {};
	}
	try {
		const parsed = JSON.parse(raw);
		return isRecord(parsed) ? parsed : {};
	} catch (err) {
		throw new Error(`Cannot parse ${file} — refusing to overwrite it.`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// #endregion
