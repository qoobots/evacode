/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { EvaAuthService } from './evaAuth';
import { readConfig, type EvaConfig } from './evaConfig';
import { streamChat } from './evaChat';
import { describeModel, fetchModels, orderModels, type EvaModelCatalog } from './evaModels';

/**
 * Must match `contributes.languageModelChatProviders[].vendor` in package.json, otherwise the
 * provider never becomes visible to the model picker.
 */
const VENDOR = 'eva-ai';

/** Bumped whenever the model list would change for reasons visible to the user. */
const MODEL_VERSION = '1.0';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const auth = new EvaAuthService(context.secrets, readConfig);
	await auth.load();

	const provider = new EvaLanguageModelChatProvider(auth, readConfig);
	context.subscriptions.push(provider);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));

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

		const preferred = config.defaultModel || catalog.defaultId || ids[0] || '';
		const ordered = orderModels(ids, preferred, undefined);

		const models = ordered.map(id => {
			const description = describeModel(id);
			return {
				id,
				name: description.name,
				family: description.family,
				version: MODEL_VERSION,
				detail: description.detail,
				tooltip: description.tooltip,
				maxInputTokens: config.maxInputTokens,
				maxOutputTokens: config.maxOutputTokens,
				capabilities: {
					// The gateway exposes no owner-supplied model metadata, and the models served here
					// are text-only - a vision claim would just fail at request time.
					imageInput: false,
					toolCalling: true,
				},
			} satisfies vscode.LanguageModelChatInformation;
		});

		this.cacheKey = key;
		this.cachedModels = models;
		return [...models];
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const config = this.getConfig();
		const accessToken = await this.auth.getAccessToken();
		if (!accessToken) {
			throw new Error('尚未登录 Eva AI。请运行命令“Eva AI: 登录”后再发起对话。');
		}

		const controller = new AbortController();
		const listener = token.onCancellationRequested(() => controller.abort());
		try {
			await streamChat({
				baseUrl: config.aiBaseUrl,
				token: accessToken,
				model: model.id,
				messages,
				tools: options.tools,
				temperature: config.temperature,
				maxOutputTokens: config.maxOutputTokens,
				signal: controller.signal,
				handlers: {
					onText: text => progress.report(new vscode.LanguageModelTextPart(text)),
					onToolCall: calls => {
						for (const call of calls) {
							progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, parseArguments(call.arguments)));
						}
					},
				},
			});
		} finally {
			listener.dispose();
		}
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		// The gateway returns no `usage` at all, so eva-desktop estimates the same way (chars / 4).
		const value = typeof text === 'string' ? text : JSON.stringify(text);
		return Math.ceil(value.length / 4);
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
