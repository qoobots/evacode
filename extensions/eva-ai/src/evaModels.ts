/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Model discovery and presentation metadata.
 *
 * The gateway is authoritative for *which* models exist (`GET /models` returns ids only), but it
 * does not report token limits, families or display names. Those come from a local catalog, which
 * is why unknown ids are still advertised with generic metadata instead of being dropped - a model
 * without local metadata is still usable, only less well described.
 */

export interface EvaModelCatalog {
	/** ids in gateway order */
	readonly ids: readonly string[];
	readonly defaultId: string | undefined;
}

/**
 * Our own placeholder for "let the platform decide".
 *
 * It is never sent to the gateway as-is unless the gateway told us no default, because upstream
 * silently falls back to its default for model ids it does not recognise - which would quietly make
 * every Auto request run on the same model while looking like a deliberate choice.
 */
export const AUTO_MODEL_ID = 'auto';

/**
 * Real per-model limits, measured from eva-ai itself rather than assumed.
 *
 * Nothing in the API reports them: `/api/ai/v1/models` returns only `id`/`object`/`owned_by`, and
 * the platform's own model registry (`/api/ai/models`, 254 rows) carries a `config` field that is
 * `null` for every row. The numbers below are read out of the service's parameter validation, which
 * rejects an out-of-range request with the interval it allows:
 *
 *   max_tokens: 999999999  ->  "Range of max_tokens should be [1, 32768]"
 *   (oversized input)      ->  "Range of input length should be [1, 1000000]"
 *
 * Both probes cost nothing *because* they are rejected - the model never runs. That is also the trap
 * when re-measuring the input limit: a payload that fits is really processed (and billed), so it has
 * to be larger than every model's context. ~2.5M Chinese characters is above all of them here; one
 * call per model, then read the two ranges out of the error.
 *
 * Two entries are incomplete rather than invented:
 *  - qwen-long: its input limit is unreachable, because eva-ai rejects request bodies over 16MB
 *    ("Exceeded limit on max bytes to request body : 16777216") before the model's context limit
 *    applies. The value stored is the largest payload that was accepted, i.e. a lower bound.
 *  - deepseek-*: the service accepts any `max_tokens` for these, so there is no output limit to
 *    read. `undefined` means "the service imposes none", and the configured fallback is used.
 */
export interface EvaModelLimits {
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
}

/** A raw measured row. `maxOutputTokens: undefined` means "the service imposes no limit". */
interface MeasuredLimits {
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number | undefined;
}

const MEASURED_LIMITS: Readonly<Record<string, MeasuredLimits>> = {
	'qwen-plus': { maxInputTokens: 1_000_000, maxOutputTokens: 32_768 },
	'qwen-plus-latest': { maxInputTokens: 1_000_000, maxOutputTokens: 32_768 },
	'qwen-turbo': { maxInputTokens: 1_000_000, maxOutputTokens: 16_384 },
	'qwen-flash': { maxInputTokens: 1_000_000, maxOutputTokens: 32_768 },
	'qwen-max': { maxInputTokens: 30_720, maxOutputTokens: 8_192 },
	'qwen-long': { maxInputTokens: 2_000_000, maxOutputTokens: 32_768 },
	'qwen3.8-max': { maxInputTokens: 983_616, maxOutputTokens: 131_072 },
	'qwen3.7-plus': { maxInputTokens: 983_616, maxOutputTokens: 131_072 },
	'qwen3.8-flash': { maxInputTokens: 983_616, maxOutputTokens: 131_072 },
	'qwen3-max': { maxInputTokens: 258_048, maxOutputTokens: 65_536 },
	'qwen3-coder-plus': { maxInputTokens: 1_048_576, maxOutputTokens: 65_536 },
	'glm-5.2': { maxInputTokens: 1_048_576, maxOutputTokens: 131_072 },
	'kimi-k3': { maxInputTokens: 1_048_576, maxOutputTokens: 1_048_576 },
	'deepseek-v3': { maxInputTokens: 131_072, maxOutputTokens: undefined },
	'deepseek-v4-pro-0813': { maxInputTokens: 1_000_000, maxOutputTokens: undefined },
	'deepseek-v4.1-flash': { maxInputTokens: 1_000_000, maxOutputTokens: undefined },
};

/**
 * Output ceilings measured against each vendor's **own** endpoint, not against eva-ai.
 *
 * Keyed by endpoint rather than by model id, because the same id does not mean the same model on two
 * endpoints: `deepseek-v4-pro` answers DeepSeek's own API with `max_tokens` capped at 393216, while
 * the Alibaba Token Plan endpoint accepted `max_tokens: 999999999` for it and replied for real. A
 * table keyed by id alone would have to pick one of those and be wrong on the other.
 *
 * Why only output ceilings: reading one is cheap and safe - an out-of-range `max_tokens` is rejected
 * before the model runs, and the rejection quotes the interval it allows - whereas reading an *input*
 * ceiling requires a payload larger than the model's entire context. So input limits for these
 * endpoints remain the configured fallback, which is why `limitsForEndpoint` keeps the fallback for
 * input while using the measured output. Absence from the table means "not measured", not "no limit".
 */
const BYOK_OUTPUT_LIMITS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
	//   max_tokens: 999999999 -> "Invalid max_tokens value, the valid range of max_tokens is [1, 393216]"
	'https://api.deepseek.com': {
		'deepseek-v4-pro': 393_216,
		'deepseek-flash': 393_216,
	},
	//   max_tokens: 999999999 -> "Range of max_tokens should be [1, 131072]"
	//   (qwen3.6-flash is the outlier at [1, 65536])
	'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1': {
		'qwen3.8-max': 131_072,
		'qwen3.8-flash': 131_072,
		'qwen3.7-max': 131_072,
		'qwen3.7-plus': 131_072,
		'qwen3.6-flash': 65_536,
		'glm-5.3': 131_072,
	},
};

/** Normalises an endpoint for {@link BYOK_OUTPUT_LIMITS} lookups. */
function endpointKey(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, '');
}

/**
 * Limits for a model on a given endpoint: a measurement for that endpoint first, then a measurement
 * made against eva-ai, then the configured fallback.
 *
 * The fallback exists for models and endpoints added later; it is deliberately not silently applied
 * to models we did measure, because a wrong context window is what makes the chat truncate early or
 * send a request the service then rejects.
 */
/**
 * Limits measured against eva-ai itself, or the configured fallback.
 *
 * The fallback exists for models the platform adds later; it is deliberately not silently applied to
 * models we did measure, because a wrong context window is what makes the chat truncate early or
 * send a request the service then rejects.
 */
export function limitsFor(id: string, fallback: EvaModelLimits): EvaModelLimits {
	const measured = MEASURED_LIMITS[id];
	if (!measured) {
		return fallback;
	}
	return {
		maxInputTokens: measured.maxInputTokens,
		maxOutputTokens: measured.maxOutputTokens ?? fallback.maxOutputTokens,
	};
}

export function limitsForEndpoint(baseUrl: string, id: string, fallback: EvaModelLimits): EvaModelLimits {
	const byok = BYOK_OUTPUT_LIMITS[endpointKey(baseUrl)]?.[id];
	if (byok !== undefined) {
		return {
			maxInputTokens: fallback.maxInputTokens,
			maxOutputTokens: byok,
		};
	}
	return limitsFor(id, fallback);
}

/** True when the limit was measured from eva-ai rather than taken from settings. */
export function hasMeasuredLimits(id: string): boolean {
	return id in MEASURED_LIMITS;
}

interface ApiModelRaw {
	readonly id?: unknown;
}

export async function fetchModels(baseUrl: string, token: string): Promise<EvaModelCatalog> {
	const url = `${trimSlash(baseUrl)}/models`;
	let response: Response;
	try {
		response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	} catch (err) {
		// Wording stays endpoint-neutral: this is used for the EVA gateway and for BYOK endpoints
		// alike, and naming the wrong one sends people looking in the wrong place.
		throw new Error(`连不上模型端点（${url}）：${err instanceof Error ? err.message : String(err)}`);
	}
	if (!response.ok) {
		throw new Error(`模型端点返回 HTTP ${response.status}${response.status === 401 || response.status === 403 ? '（Key 无效或已失效）' : ''}`);
	}
	const text = await response.text();
	let body: { data?: unknown; models?: unknown; default?: unknown } = {};
	try {
		body = text ? JSON.parse(text) : {};
	} catch (err) {
		throw new Error(`模型端点返回的模型清单无法解析：${err instanceof Error ? err.message : String(err)}`);
	}
	const raw = Array.isArray(body.data) ? body.data as ApiModelRaw[] : Array.isArray(body.models) ? body.models as ApiModelRaw[] : [];
	const ids: string[] = [];
	for (const entry of raw) {
		const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
		if (id && !ids.includes(id)) {
			ids.push(id);
		}
	}
	return {
		ids,
		defaultId: typeof body.default === 'string' ? body.default : undefined,
	};
}

export interface EvaModelDescription {
	readonly name: string;
	readonly family: string;
	readonly detail: string | undefined;
	readonly tooltip: string;
}

/**
 * Human-facing names for the ids we know about. Anything absent falls back to the raw id, so a new
 * upstream model shows up immediately rather than after a catalog update here.
 */
const KNOWN_MODELS: Readonly<Record<string, { name: string; detail?: string }>> = {
	'qwen-plus': { name: 'Qwen Plus', detail: '通义千问 · 均衡' },
	'qwen-plus-latest': { name: 'Qwen Plus (最新)', detail: '通义千问 · 最新档' },
	'qwen-turbo': { name: 'Qwen Turbo', detail: '通义千问 · 快速' },
	'qwen-max': { name: 'Qwen Max', detail: '通义千问 · 强推理' },
	'qwen-flash': { name: 'Qwen Flash', detail: '通义千问 · 极速' },
	'qwen-long': { name: 'Qwen Long', detail: '通义千问 · 长上下文' },
	'qwen3-max': { name: 'Qwen3 Max', detail: '通义千问 3 · 旗舰' },
	'qwen3.8-max': { name: 'Qwen3.8 Max', detail: '通义千问 3.8 · 旗舰' },
	'qwen3.7-plus': { name: 'Qwen3.7 Plus', detail: '通义千问 3.7 · 均衡' },
	'qwen3.8-flash': { name: 'Qwen3.8 Flash', detail: '通义千问 3.8 · 极速' },
	'qwen3-coder-plus': { name: 'Qwen3 Coder Plus', detail: '通义千问 3 · 编码' },
	'deepseek-v3': { name: 'DeepSeek V3', detail: '深度求索 · 通用' },
	'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', detail: '深度求索 V4 · 强推理' },
	'deepseek-flash': { name: 'DeepSeek Flash', detail: '深度求索 · 快速' },
	'deepseek-v4-flash-0731': { name: 'DeepSeek V4 Flash', detail: '深度求索 V4 · 快速' },
	'deepseek-v4-pro-0813': { name: 'DeepSeek V4 Pro (0813)', detail: '深度求索 V4 · 强推理' },
	'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', detail: '深度求索 V4 · 快速' },
	'qwen3.6-flash': { name: 'Qwen3.6 Flash', detail: '通义千问 3.6 · 极速' },
	'kimi-k3': { name: 'Kimi K3', detail: '月之暗面 · 长上下文' },
	'glm-5.2': { name: 'GLM 5.2', detail: '智谱 · 通用' },
	'glm-5.3': { name: 'GLM 5.3', detail: '智谱 · 通用' },
};

/**
 * Model families that are not chat models, filtered out of `/models` listings.
 *
 * A BYOK endpoint's model list is not curated for us: the Alibaba Token Plan one also serves image,
 * video and audio models (`wan*`, `qwen-audio-*`), plus an internal `decision-model-preview`. Those
 * would appear in the picker and then fail at request time, which reads as a broken extension rather
 * than as an inapplicable model. The list is deliberately matched on prefixes, since vendors add
 * numbered variants rather than new families.
 */
const NON_CHAT_PREFIXES = ['wan', 'qwen-audio', 'qwen-vl-o', 'decision-model'] as const;

export function isChatModelId(id: string): boolean {
	const lower = id.trim().toLowerCase();
	return lower.length > 0 && !NON_CHAT_PREFIXES.some(prefix => lower.startsWith(prefix));
}

export function describeModel(id: string): EvaModelDescription {
	const known = KNOWN_MODELS[id];
	const family = familyOf(id);
	return {
		name: known?.name ?? id,
		family,
		detail: known?.detail,
		tooltip: known?.detail ? `${known.name} · ${known.detail}（${id}）` : id,
	};
}

function familyOf(id: string): string {
	const lower = id.toLowerCase();
	// `kimi-k3` and friends stay unhyphenated so their family reads naturally in the picker.
	for (const prefix of ['qwen', 'deepseek', 'kimi', 'glm', 'zhipu', 'minimax', 'mimo']) {
		if (lower.startsWith(prefix)) {
			return prefix;
		}
	}
	return lower.split(/[-._/]/)[0] || 'eva';
}

export function orderModels(ids: readonly string[], preferred: string, fallbackDefault: string | undefined): string[] {
	const unique: string[] = [];
	const push = (value: string) => {
		if (value && !unique.includes(value)) {
			unique.push(value);
		}
	};
	push(preferred);
	push(fallbackDefault ?? '');
	for (const id of ids) {
		push(id);
	}
	return unique;
}

function trimSlash(value: string): string {
	return value.replace(/\/+$/, '');
}
