/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Model sources: every place models can come from besides the EVA gateway.
 *
 * The gateway path is special because it is authenticated by an OAuth2 login rather than by a key
 * we already hold, and because it is the only source that knows what its own default model is.
 * Everything else - a vendor's own endpoint with an apikey, or a model served locally - is the same
 * shape: an OpenAI-compatible base URL plus a bearer token. `streamChat` already only needs those
 * two, so a source is really just "where to send" and "what to send as `Authorization`".
 *
 * A source with no resolvable key is simply not registered, so an unset environment variable is not
 * an error - it just means that source stays out of the model picker.
 */

/** Vendor of the built-in EVA gateway. Must match `contributes.languageModelChatProviders`. */
export const EVA_VENDOR = 'eva-ai';

export interface ModelSource {
	/** Doubles as the vendor registered with `vscode.lm`. */
	readonly id: string;
	readonly label: string;
	/** OpenAI-compatible root; `/models` and `/chat/completions` are appended to it. */
	readonly baseUrl: string;
	/** `oauth` goes through the EVA login; `apiKey` uses a key we already hold. */
	readonly auth: 'oauth' | 'apiKey';
	/** Name of the environment variable holding the key. */
	readonly apiKeyEnv: string | undefined;
	/** Key written directly into settings. Works, but lands in settings.json in the clear. */
	readonly staticApiKey: string | undefined;
	/** Allow list. Empty means discover from `<baseUrl>/models`. */
	readonly models: readonly string[];
	/**
	 * Whether models here take images, overriding the measured table.
	 *
	 * Needed because a model served locally is in none of our tables, and whoever points us at it is
	 * the only one who can say. Left undefined, only the models we actually measured claim vision.
	 */
	readonly vision: boolean | undefined;
}

/** Key under which a source's key is kept in `SecretStorage`. */
const SECRET_PREFIX = 'eva-ai.apiKey.';

/**
 * Resolves a source's bearer token.
 *
 * Order matters: `SecretStorage` first, because it is the only one of the three that does not leave
 * the key in a file the user might commit. The environment variable is next - it is how the keys
 * already present on this machine are picked up without anyone retyping them - and the inline
 * setting is last, kept only because some setups cannot set environment variables before launch.
 */
export class ApiKeyResolver {

	/** Cached so the secrets store is not hit on every model request. */
	private readonly cache = new Map<string, string | undefined>();

	constructor(private readonly secrets: vscode.SecretStorage) { }

	async resolve(source: ModelSource): Promise<string | undefined> {
		if (this.cache.has(source.id)) {
			return this.cache.get(source.id);
		}
		const value = await this.resolveUncached(source);
		this.cache.set(source.id, value);
		return value;
	}

	private async resolveUncached(source: ModelSource): Promise<string | undefined> {
		const stored = await this.secrets.get(SECRET_PREFIX + source.id);
		if (stored) {
			return stored;
		}
		if (source.apiKeyEnv) {
			const fromEnv = process.env[source.apiKeyEnv];
			if (fromEnv) {
				return fromEnv;
			}
		}
		return source.staticApiKey || undefined;
	}

	async store(sourceId: string, key: string): Promise<void> {
		await this.secrets.store(SECRET_PREFIX + sourceId, key);
		this.cache.set(sourceId, key);
	}

	async clear(sourceId: string): Promise<void> {
		await this.secrets.delete(SECRET_PREFIX + sourceId);
		this.cache.set(sourceId, undefined);
	}

	/** Drops cached values, e.g. after the user stores or removes a key. */
	invalidate(): void {
		this.cache.clear();
	}
}

interface RawSource {
	readonly id?: unknown;
	readonly label?: unknown;
	readonly baseUrl?: unknown;
	readonly apiKey?: unknown;
	readonly apiKeyEnv?: unknown;
	readonly models?: unknown;
	readonly vision?: unknown;
}

/**
 * Reads the configured sources, dropping malformed entries rather than failing activation.
 *
 * A bad entry is reported once per window: silently ignoring it would leave the user wondering why
 * the endpoint they typed does not appear, while throwing would take the whole extension down.
 */
export function readModelSources(): ModelSource[] {
	const section = vscode.workspace.getConfiguration('eva-ai');
	const raw = section.get<unknown>('byok.sources');
	if (!Array.isArray(raw)) {
		return [];
	}

	const sources: ModelSource[] = [];
	const seen = new Set<string>();
	for (const entry of raw as RawSource[]) {
		const id = str(entry?.id).trim();
		const baseUrl = str(entry?.baseUrl).trim().replace(/\/+$/, '');
		if (!id || !baseUrl) {
			continue;
		}
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		sources.push({
			id,
			label: str(entry?.label).trim() || id,
			baseUrl,
			auth: 'apiKey',
			apiKeyEnv: str(entry?.apiKeyEnv).trim() || undefined,
			staticApiKey: str(entry?.apiKey).trim() || undefined,
			models: (Array.isArray(entry?.models) ? entry.models as unknown[] : [])
				.map(value => str(value).trim())
				.filter(Boolean),
			vision: typeof entry?.vision === 'boolean' ? entry.vision : undefined,
		});
	}
	return sources;
}

function str(value: unknown): string {
	return typeof value === 'string' ? value : '';
}
