/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { endpointKey } from './evaModels';

/**
 * The behaviour of an endpoint that is **not** covered by the OpenAI-compatible contract.
 *
 * The contract settles the shape of a request and of a streaming response. Everything here is
 * something real endpoints disagreed about, found by using them:
 *
 *  - **Which field carries chain-of-thought.** DashScope/Qwen send `reasoning_content`, others send
 *    `reasoning` or `reasoning_text`. Nobody agrees, and missing the field does not error - the
 *    model's reasoning silently lands in the answer text instead.
 *  - **Which optional parameters an endpoint rejects**, so they can be dropped and retried instead
 *    of failing the whole request.
 *  - **Whether a model really accepts images.** No endpoint publishes this, and it is the one
 *    capability the host asks us to declare up front.
 *
 * Keyed by endpoint rather than by model id, for the same reason the limit tables are: the same id
 * means different things on different endpoints.
 */

/** Request parameters we are willing to send without, if an endpoint refuses them. */
export type DroppableParamName = 'temperature' | 'stream_options';

export interface DroppableParam {
	readonly name: DroppableParamName;
	/** Matched against the error text the endpoint sends back. */
	readonly pattern: RegExp;
}

export interface ModelAdapter {
	/** Delta fields to read as chain-of-thought, in preference order. */
	readonly thinkingFields: readonly string[];
	/**
	 * Parameters to sacrifice, in order, when an endpoint rejects one.
	 *
	 * Only genuinely optional parameters belong here. `max_tokens` is deliberately absent: an
	 * out-of-range complaint about it should be answered by clamping, and dropping it altogether
	 * would let a model generate without a bound.
	 */
	readonly droppableParams: readonly DroppableParam[];
	supportsImages(modelId: string): boolean;
}

/**
 * Assumed for any endpoint we have not measured.
 *
 * The defaults are the conservative ones: read every known thinking field so reasoning is never
 * lost, allow the two safe degradations, and claim no vision - a false vision claim fails at
 * request time and reads as a broken extension, whereas claiming no vision only costs a feature.
 */
const GENERIC: ModelAdapter = {
	thinkingFields: ['reasoning_content', 'reasoning', 'reasoning_text'],
	droppableParams: [
		// Seen on kimi-k3 behind the EVA gateway: it refuses the parameter outright.
		{ name: 'temperature', pattern: /temperature/i },
		// Self-hosted servers (vLLM, Ollama) commonly reject the whole key, not just the value.
		{ name: 'stream_options', pattern: /stream_options|include_usage/i },
	],
	supportsImages: () => false,
};

/**
 * Vision support, measured 2026-10-15.
 *
 * Method: send a 16x16 solid red PNG and ask for its RGB. A model that sees it answers `(255,0,0)`;
 * one that does not answers `NO_VISION`.
 *
 * Every entry is the model's **actual answer**, not whether the request was accepted - and that
 * distinction is the whole difficulty here. Two traps, both of which produce a wrong conclusion if
 * you are careless:
 *
 *  - **Asking too cheaply.** With `max_tokens: 48` a reasoning model spends the entire budget on
 *    reasoning and the answer comes back empty, which looks exactly like "cannot see images".
 *    `deepseek-flash` read as text-only at 48 and answered correctly at 400.
 *  - **Accepting is not seeing.** DeepSeek took a 1x1 image without complaint and then said it
 *    could not see one, while the Alibaba endpoint *rejected* that same image for being under 10px
 *    - a rejection which proves it does look at images. So neither a 200 nor a 400 settles it.
 *
 * Note `qwen3.7-plus` has vision while `qwen3.7-max` does not: the capability does not follow the
 * family, which is exactly why this cannot be inferred from the name.
 */
const VISION_BY_ENDPOINT: Readonly<Record<string, Readonly<Record<string, boolean>>>> = {
	'https://api.deepseek.com': {
		'deepseek-v4-pro': false,	// NO_VISION, twice
		'deepseek-flash': true,		// (255,0,0)
	},
	'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1': {
		'qwen3.8-max': true,
		'qwen3.8-flash': true,
		'qwen3.7-plus': true,
		'qwen3.6-flash': true,
		'deepseek-v4.1-flash': true,
		'auto': true,
		// Rejects image parts outright: "Unexpected item type in content."
		'qwen3.7-max': false,
		'glm-5.2': false,
		'glm-5.3': false,
		'deepseek-v4-pro': false,
		'deepseek-v4-flash-0731': false,
	},
};

/**
 * Picks the adapter for an endpoint.
 *
 * `imageOverride` comes from the source's own configuration and wins over the measurements, because
 * a locally served model is not in any table we keep - whoever points us at it is the only one who
 * can say what it takes.
 */
export function resolveAdapter(baseUrl: string, imageOverride?: boolean): ModelAdapter {
	if (imageOverride === undefined) {
		const measured = VISION_BY_ENDPOINT[endpointKey(baseUrl)];
		if (!measured) {
			return GENERIC;
		}
		return {
			...GENERIC,
			supportsImages: (modelId: string) => measured[modelId] ?? false,
		};
	}
	return {
		...GENERIC,
		supportsImages: () => imageOverride,
	};
}
