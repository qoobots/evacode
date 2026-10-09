/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { EvaAuthService } from './evaAuth';
import { EvaAuthenticationProvider } from './evaAuthProvider';
import { readConfig, type EvaConfig } from './evaConfig';
import { streamChat, type EvaUsage } from './evaChat';
import { AUTO_MODEL_ID, describeModel, fetchModels, limitsFor, orderModels, type EvaModelCatalog } from './evaModels';
import { EvaLocalProxy } from './evaProxy';
import { applyCliConfig, cliTargets, restoreCliConfig } from './evaCliConfig';

/**
 * Must match `contributes.languageModelChatProviders[].vendor` in package.json, otherwise the
 * provider never becomes visible to the model picker.
 */
const VENDOR = 'eva-ai';

/** Must match `contributes.authentication[].id` in package.json. */
const AUTH_PROVIDER_ID = 'eva';

/** Bumped whenever the model list would change for reasons visible to the user. */
const MODEL_VERSION = '1.0';

/**
 * Seed for the chars-per-token estimate, used only until the first real `prompt_tokens` arrives.
 *
 * 2 is deliberately conservative: Latin text is nearer 4, but a Chinese character is usually a
 * token, and over-counting merely truncates early while under-counting overflows the context.
 */
const INITIAL_CHARS_PER_TOKEN = 2;

/**
 * The response parts this provider can emit.
 *
 * Stable `LanguageModelResponsePart` does not include thinking; only the `chatProvider` proposal's
 * `LanguageModelResponsePart2` does, and pulling that in drags most of the chat proposals along
 * (`ChatLocation`, `ChatToolInvocationPart`, …). The extension host accepts thinking parts from
 * providers unconditionally and exposes the class on the `vscode` API unconditionally, so this
 * union is the accurate type without the dependency chain.
 */
type EvaResponsePart = vscode.LanguageModelResponsePart | vscode.LanguageModelThinkingPart;

/**
 * `isBYOK` is still a proposed field (`vscode.proposed.chatProvider`), so it is absent from the
 * stable interface included here. It is still read by the extension host, which forwards it as-is.
 */
type EvaModelInformation = vscode.LanguageModelChatInformation & { readonly isBYOK?: boolean };

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const auth = new EvaAuthService(context.secrets, readConfig);
	await auth.load();

	const authProvider = new EvaAuthenticationProvider(auth);
	context.subscriptions.push(authProvider);
	context.subscriptions.push(vscode.authentication.registerAuthenticationProvider(AUTH_PROVIDER_ID, 'EVA', authProvider, { supportsMultipleAccounts: false }));

	const provider = new EvaLanguageModelChatProvider(auth, readConfig);
	context.subscriptions.push(provider);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));

	const proxy = new EvaLocalProxy(auth);
	context.subscriptions.push(proxy);
	context.subscriptions.push(vscode.commands.registerCommand('eva-ai.startProxy', async () => {
		try {
			const info = await proxy.start();
			await vscode.window.showInformationMessage(
				`EVA 本地代理已启动：${info.baseUrl}\nKey：${info.key}`,
				{ modal: true, detail: '外部 CLI 请把自己的 base_url 指向上面的地址，并用该 Key 鉴权。' },
				'复制地址', '复制 Key',
			).then(async choice => {
				if (choice === '复制地址') {
					await vscode.env.clipboard.writeText(`${info.baseUrl}/v1`);
				} else if (choice === '复制 Key') {
					await vscode.env.clipboard.writeText(info.key);
				}
			});
		} catch (err) {
			vscode.window.showErrorMessage(`EVA 代理启动失败：${errorMessage(err)}`);
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('eva-ai.stopProxy', async () => {
		await proxy.stop();
		vscode.window.showInformationMessage('EVA 本地代理已停止。');
	}));

	/** Picks the concrete model external CLIs should be pointed at. */
	async function resolveCliModel(): Promise<string | undefined> {
		const configured = readConfig().defaultModel;
		if (configured) {
			return configured;
		}
		const tokenSource = new vscode.CancellationTokenSource();
		try {
			const infos = await provider.provideLanguageModelChatInformation({ silent: true }, tokenSource.token);
			// Auto heads the list; the entry after it is the gateway's own preferred model.
			return infos[1]?.id ?? infos[0]?.id;
		} finally {
			tokenSource.dispose();
		}
	}

	const applyTarget = async (id: 'claudeCode' | 'codex'): Promise<void> => {
		const target = cliTargets().find(candidate => candidate.id === id);
		if (!target) {
			return;
		}
		try {
			const info = await proxy.start();
			const model = await resolveCliModel();
			if (!model) {
				vscode.window.showErrorMessage('没有可用模型：请先运行「Eva AI: 登录」。');
				return;
			}
			await applyCliConfig(target, info, model);
			vscode.window.showInformationMessage(`已把 ${target.file} 指向 EVA（模型 ${model}）。原文件已备份为 ${target.file}.eva-backup`);
		} catch (err) {
			vscode.window.showErrorMessage(`写入 ${target.file} 失败：${errorMessage(err)}`);
		}
	};

	context.subscriptions.push(vscode.commands.registerCommand('eva-ai.applyToClaudeCode', () => applyTarget('claudeCode')));
	context.subscriptions.push(vscode.commands.registerCommand('eva-ai.applyToCodex', () => applyTarget('codex')));
	context.subscriptions.push(vscode.commands.registerCommand('eva-ai.restoreCliConfig', async () => {
		let restored = 0;
		for (const target of cliTargets()) {
			if (await restoreCliConfig(target)) {
				restored++;
			}
		}
		vscode.window.showInformationMessage(restored ? `已还原 ${restored} 个 CLI 配置文件。` : '没有找到备份，无需还原。');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('eva-ai.login', async () => {
		try {
			const ok = await auth.login();
			vscode.window.showInformationMessage(ok ? 'Eva AI 登录成功。' : 'Eva AI 登录未完成。');
			provider.refresh();
		} catch (err) {
			vscode.window.showErrorMessage(`Eva AI 登录失败：${errorMessage(err)}`);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('eva-ai.logout', async () => {
		await auth.logout();
		provider.refresh();
		vscode.window.showInformationMessage('已退出 Eva AI。');
	}));

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
		if (e.affectsConfiguration('eva-ai')) {
			provider.refresh();
		}
	}));
}

export function deactivate(): void {
	// nothing to clean up beyond disposables registered on the extension context
}

class EvaLanguageModelChatProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	/** Short-lived /models cache: the gateway has no token limits to vary, so this is cheap. */
	private cachedModels: readonly vscode.LanguageModelChatInformation[] | undefined;
	private cacheKey: string | undefined;
	/** The gateway's own default, used to resolve the Auto entry. */
	private defaultModelId: string | undefined;
	/** Chars in the last prompt per model, so real `prompt_tokens` can calibrate the estimate. */
	private readonly promptChars = new Map<string, number>();
	/** Learned chars-per-token per model; see {@link learnCharsPerToken}. */
	private readonly charsPerToken = new Map<string, number>();

	private readonly authListener: vscode.Disposable;

	constructor(
		private readonly auth: EvaAuthService,
		private readonly getConfig: () => EvaConfig,
	) {
		this.authListener = auth.onDidChange(() => this.refresh());
	}

	dispose(): void {
		this.authListener.dispose();
		this._onDidChange.dispose();
	}

	refresh(): void {
		this.cachedModels = undefined;
		this.cacheKey = undefined;
		this._onDidChange.fire();
	}

	/**
	 * Resolves a usable access token, offering the browser login when we are allowed to prompt.
	 *
	 * Returning `undefined` for a silent caller is important: the model picker samples providers
	 * continuously, and a notification during that sampling would be noise.
	 */
	private async ensureAccessToken(silent: boolean): Promise<string | undefined> {
		const existing = await this.auth.getAccessToken();
		if (existing) {
			return existing;
		}
		if (silent) {
			return undefined;
		}
		const choice = await vscode.window.showWarningMessage('需要登录 Eva AI 才能使用其模型。', '登录');
		if (choice !== '登录') {
			return undefined;
		}
		try {
			if (!await this.auth.login()) {
				return undefined;
			}
		} catch (err) {
			vscode.window.showErrorMessage(`Eva AI 登录失败：${errorMessage(err)}`);
			return undefined;
		}
		return this.auth.getAccessToken();
	}

	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		_cancellationToken: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		const config = this.getConfig();

		const accessToken = await this.ensureAccessToken(options.silent);
		if (!accessToken) {
			return [];
		}

		const key = `${config.aiBaseUrl}|${config.models.join(',')}|${config.defaultModel}|${config.maxInputTokens}|${config.maxOutputTokens}`;
		if (this.cachedModels && this.cacheKey === key) {
			return [...this.cachedModels];
		}

		let catalog: EvaModelCatalog;
		try {
			catalog = await fetchModels(config.aiBaseUrl, accessToken);
		} catch (err) {
			vscode.window.showErrorMessage(`无法读取 Eva AI 模型清单：${errorMessage(err)}`);
			throw err;
		}

		let ids: readonly string[] = catalog.ids;
		if (config.models.length) {
			const allowList = new Set(config.models);
			ids = ids.filter(id => allowList.has(id));
		}

		this.defaultModelId = catalog.defaultId;

		const preferred = config.defaultModel || catalog.defaultId || ids[0] || '';
		const ordered = orderModels(ids, preferred, undefined);

		const models: vscode.LanguageModelChatInformation[] = ordered.map(id => {
			const description = describeModel(id);
			const limits = limitsFor(id, config);
			return {
				id,
				name: description.name,
				family: description.family,
				version: MODEL_VERSION,
				detail: description.detail,
				tooltip: description.tooltip,
				maxInputTokens: limits.maxInputTokens,
				maxOutputTokens: limits.maxOutputTokens,
				capabilities: {
					// The gateway exposes no owner-supplied model metadata, and the models served here
					// are text-only - a vision claim would just fail at request time.
					imageInput: false,
					toolCalling: true,
				},
				// Publishes these models to the agent host. Only models flagged `isBYOK` are pushed
				// to `AgentHostByokLmHandler`, and that handler is what both fills the agent sessions
				// model catalogue and routes those sessions' inference back through this provider.
				isBYOK: true,
			} satisfies EvaModelInformation;
		});

		// Auto goes first so it is the default pick.
		//
		// The gateway has no literal "auto": asking for it returns HTTP 200 with `model` echoed back
		// as its own default, the same silent fallback it applies to any id it does not recognise.
		// So Auto resolves to that declared default, rather than pretending the platform picks per
		// request. Its limits are the ones measured for that default model, not a generic guess.
		const autoLimits = limitsFor(catalog.defaultId ?? AUTO_MODEL_ID, config);
		const autoModel: EvaModelInformation = {
			id: AUTO_MODEL_ID,
			name: '自动（Auto）',
			family: 'auto',
			version: MODEL_VERSION,
			detail: '由平台选择最合适的模型',
			tooltip: catalog.defaultId ? `由平台选择最合适的模型（平台当前默认：${catalog.defaultId}）` : '由平台选择最合适的模型',
			maxInputTokens: autoLimits.maxInputTokens,
			maxOutputTokens: autoLimits.maxOutputTokens,
			capabilities: {
				imageInput: false,
				toolCalling: true,
			},
			isBYOK: true,
		};
		models.unshift(autoModel);

		this.cacheKey = key;
		this.cachedModels = models;
		return [...models];
	}

	/** Resolves our Auto placeholder to a concrete id before it reaches the gateway. */
	private resolveModelId(id: string): string {
		if (id !== AUTO_MODEL_ID) {
			return id;
		}
		return this.defaultModelId ?? AUTO_MODEL_ID;
	}

	/**
	 * Returns an access token, signing the user in when there is no session yet.
	 *
	 * Going through the authentication provider rather than telling the user to run a command is
	 * deliberate: signing in this way creates a real session, and a session is the only thing that
	 * makes EVA appear in the accounts menu. VS Code lists *accounts*, not registered providers -
	 * `GlobalCompositeBar.addAccountsFromProvider` drops any provider whose `getSessions()` is empty,
	 * so a merely-registered provider stays invisible until the first sign-in. `createIfNone` only
	 * prompts when no session exists, so an already signed-in user never sees a dialog here.
	 */
	private async requestAccessToken(): Promise<string> {
		const session = await vscode.authentication.getSession(AUTH_PROVIDER_ID, [], { createIfNone: true });
		return session.accessToken;
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<EvaResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const config = this.getConfig();
		const accessToken = await this.requestAccessToken();

		const controller = new AbortController();
		const listener = token.onCancellationRequested(() => controller.abort());
		const targetId = this.resolveModelId(model.id);
		this.promptChars.set(targetId, JSON.stringify(messages).length);
		try {
			await streamChat({
				baseUrl: config.aiBaseUrl,
				token: accessToken,
				model: targetId,
				messages,
				tools: options.tools,
				temperature: config.temperature,
				// Per model, from the limits measured against eva-ai: asking for more than the service
				// allows is a hard 400 ("Range of max_tokens should be [1, N]").
				maxOutputTokens: limitsFor(targetId, config).maxOutputTokens,
				signal: controller.signal,
				handlers: {
					onText: text => progress.report(new vscode.LanguageModelTextPart(text)),
					onThinking: text => progress.report(new vscode.LanguageModelThinkingPart(text)),
					onToolCall: calls => {
						for (const call of calls) {
							progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, parseArguments(call.arguments)));
						}
					},
					onUsage: usage => this.learnCharsPerToken(targetId, usage),
				},
			});
		} finally {
			listener.dispose();
		}
	}

	async provideTokenCount(
		model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		const value = typeof text === 'string' ? text : JSON.stringify(text);
		const ratio = this.charsPerToken.get(this.resolveModelId(model.id)) ?? INITIAL_CHARS_PER_TOKEN;
		return Math.max(1, Math.ceil(value.length / ratio));
	}

	/**
	 * Keeps the chars-per-token ratio honest, using the token counts eva-ai actually reports.
	 *
	 * A fixed chars/4 is only right for Latin text: in Chinese a character is usually a token, so
	 * chars/4 under-counts the prompt roughly threefold and makes the context window look far larger
	 * than it is. `stream_options.include_usage` gives us the real `prompt_tokens` on every response,
	 * so the estimate corrects itself. Smoothing keeps one short request from pinning the ratio.
	 */
	private learnCharsPerToken(modelId: string, usage: EvaUsage): void {
		const promptTokens = usage.prompt_tokens;
		const chars = this.promptChars.get(modelId);
		if (!promptTokens || !chars) {
			return;
		}
		const observed = chars / promptTokens;
		const previous = this.charsPerToken.get(modelId);
		this.charsPerToken.set(modelId, previous ? previous * 0.7 + observed * 0.3 : observed);
	}
}

function parseArguments(raw: string): object {
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed as object : {};
	} catch {
		return {};
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
