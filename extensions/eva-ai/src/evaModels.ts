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

interface ApiModelRaw {
	readonly id?: unknown;
}

export async function fetchModels(baseUrl: string, token: string): Promise<EvaModelCatalog> {
	const url = `${trimSlash(baseUrl)}/models`;
	let response: Response;
	try {
		response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	} catch (err) {
		throw new Error(`连不上 EVA AI 网关（${url}）：${err instanceof Error ? err.message : String(err)}`);
	}
	if (!response.ok) {
		throw new Error(`EVA AI 网关返回 HTTP ${response.status}${response.status === 401 || response.status === 403 ? '（登录态已失效，请重新登录）' : ''}`);
	}
	const text = await response.text();
	let body: { data?: unknown; models?: unknown; default?: unknown } = {};
	try {
		body = text ? JSON.parse(text) : {};
	} catch (err) {
		throw new Error(`EVA AI 网关返回的模型清单无法解析：${err instanceof Error ? err.message : String(err)}`);
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
	'deepseek-v4-pro-0813': { name: 'DeepSeek V4 Pro', detail: '深度求索 V4 · 强推理' },
	'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', detail: '深度求索 V4 · 快速' },
	'kimi-k3': { name: 'Kimi K3', detail: '月之暗面 · 长上下文' },
	'glm-5.2': { name: 'GLM 5.2', detail: '智谱 · 通用' },
};

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
