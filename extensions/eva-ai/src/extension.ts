/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { EvaAuthService } from './evaAuth';
import { EvaAuthenticationProvider } from './evaAuthProvider';
import { readConfig, type EvaConfig } from './evaConfig';
import { streamChat, type EvaUsage } from './evaChat';
import { AUTO_MODEL_ID, describeModel, fetchModels, isChatModelId, limitsFor, limitsForEndpoint, orderModels, type EvaModelCatalog } from './evaModels';
import { ApiKeyResolver, EVA_VENDOR, readModelSources, type ModelSource } from './modelSources';
import { EvaLocalProxy } from './evaProxy';
import { readTraceConfig, setTraceDirectory, setTraceLogger } from './evaTrace';
import { applyCliConfig, cliTargets, CLI_TIER_MODELS, restoreCliConfig, type CliModelSlots } from './evaCliConfig';

/**
 * Must match `contributes.languageModelChatProviders[].vendor` in package.json, otherwise the
 * provider never becomes visible to the model picker.
 */
const VENDOR = EVA_VENDOR;

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

	const keys = new ApiKeyResolver(context.secrets);

	/**
	 * The EVA gateway. It is the only source whose availability depends on being logged in, and the
	 * only one that knows its own default model - which is what makes its `Auto` entry meaningful.
	 *
	 * Its `baseUrl` is not read from here: the OAuth path resolves the address from settings on every
	 * call, so repointing the gateway in settings takes effect without restarting the window.
	 */
	const evaSource: ModelSource = {
		id: VENDOR,
		label: 'EVA',
		baseUrl: readConfig().aiBaseUrl,
		auth: 'oauth',
		apiKeyEnv: undefined,
		staticApiKey: undefined,
		models: [],
	};

	const provider = new EvaLanguageModelChatProvider(evaSource, keys, auth, readConfig);
	context.subscriptions.push(provider);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));

	/**
	 * BYOK sources each get their own provider, so they appear under their own vendor in the model
	 * picker instead of all collapsing into "Eva AI".
	 *
	 * They are rebuilt whenever settings change, because a source can be added, removed or repointed
	 * while the window is open. A source with no resolvable key registers anyway and simply reports
	 * no models - that way the picker is empty rather than the source being impossible to configure.
	 */
	let byok: vscode.Disposable[] = [];
	const syncByokSources = (): void => {
		for (const disposable of byok) {
			disposable.dispose();
		}
		byok = [];
		for (const source of readModelSources()) {
			const sourceProvider = new EvaLanguageModelChatProvider(source, keys, auth, readConfig);
			byok.push(sourceProvider);
			byok.push(vscode.lm.registerLanguageModelChatProvider(source.id, sourceProvider));
		}
	};
	syncByokSources();
	context.subscriptions.push({ dispose: () => { for (const disposable of byok) { disposable.dispose(); } } });

	const proxy = new EvaLocalProxy(auth, context.globalState);
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

	const proxyLog = vscode.window.createOutputChannel('Eva AI 本地代理');
	context.subscriptions.push(proxyLog);

	// Fallback directory for the interaction log and where a failed write is reported. Neither the
	// model provider nor the proxy ever sees the extension context, so the path is captured here.
	setTraceDirectory(context.globalStorageUri.fsPath);
	setTraceLogger(line => proxyLog.appendLine(line));
	const tracing = readTraceConfig();
	if (tracing.enabled) {
		proxyLog.appendLine(`交互日志已开启，写入 ${tracing.directory}`);
	}

	context.subscriptions.push(vscode.commands.registerCommand('eva-ai.openTraceFolder', async () => {
		await vscode.env.openExternal(vscode.Uri.file(readTraceConfig().directory));
	}));

	/**
	 * The proxy has to come up on its own, because nothing rewrites the CLI configurations it hands
	 * out: those files carry a fixed loopback port and a key persisted across windows, and they are
	 * read back long after the window that wrote them has closed. A window that never binds the port
	 * therefore strands every external CLI on a dead endpoint until someone runs the command by
	 * hand — which is what the address in `ANTHROPIC_BASE_URL` was pointing at all along.
	 */
	function ensureProxy(): void {
		if (!auth.isSignedIn || proxy.info) {
			return;
		}
		void proxy.start().then(
			info => proxyLog.appendLine(`已启动：${info.baseUrl}`),
			err => proxyLog.appendLine(`启动失败：${errorMessage(err)}`),
		);
	}

	ensureProxy();
	// Signing in usually happens after this ran, so the first attempt can meet an empty session.
	context.subscriptions.push(authProvider.onDidChangeSessions(() => ensureProxy()));

	/** Resolves the four tiers against what the gateway currently serves; see CLI_TIER_MODELS. */
	async function resolveCliModels(): Promise<CliModelSlots | undefined> {
		const tokenSource = new vscode.CancellationTokenSource();
		try {
			const infos = await provider.provideLanguageModelChatInformation({ silent: true }, tokenSource.token);
			const ids = infos.map(info => info.id).filter(id => id !== AUTO_MODEL_ID);
			const anchor = readConfig().defaultModel || ids[0];
			if (!anchor) {
				return undefined;
			}

			// Which model belongs in which tier is stated in CLI_TIER_MODELS, not recomputed here.
			// What stays the gateway's to decide is availability: a model it no longer serves falls
			// back to the one that does, so an id retired upstream cannot wedge the whole session.
			const offered = new Set(ids);
			const available = (id: string): string | undefined => offered.has(id) ? id : undefined;
			const configured = readConfig().defaultModel;
			const main = (configured && offered.has(configured) ? configured : undefined)
				?? available(CLI_TIER_MODELS.main)
				?? ids[0];
			if (!main) {
				return undefined;
			}
			return {
				main,
				opus: available(CLI_TIER_MODELS.opus) ?? main,
				haiku: available(CLI_TIER_MODELS.haiku) ?? main,
				fable: available(CLI_TIER_MODELS.fable) ?? main,
			};
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
			const models = await resolveCliModels();
			if (!models) {
				vscode.window.showErrorMessage('没有可用模型：请先运行「Eva AI: 登录」。');
				return;
			}
			await applyCliConfig(target, info, models);
			vscode.window.showInformationMessage(`已把 ${target.file} 指向 EVA（${models.main}，Opus ${models.opus}，Haiku ${models.haiku}）。原文件已备份为 ${target.file}.eva-backup`);
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

	/**
	 * Keys live in `SecretStorage` when set through this command, which is the only option that does
	 * not leave them sitting in a file the user might commit. The environment variable remains the
	 * default because that is where the keys on this machine already are.
	 */
	context.subscriptions.push(vscode.commands.registerCommand('eva-ai.setApiKey', async () => {
		const sources = readModelSources();
		if (!sources.length) {
			vscode.window.showWarningMessage('没有配置任何模型来源。请先在设置里添加 `eva-ai.byok.sources` 条目。');
			return;
		}
		const picked = await vscode.window.showQuickPick(
			sources.map(source => ({ label: source.label, description: source.baseUrl, source })),
			{ placeHolder: '要为哪个模型来源设置 API Key？' },
		);
		if (!picked) {
			return;
		}
		const key = await vscode.window.showInputBox({
			title: `${picked.source.label} 的 API Key`,
			prompt: `写入安全存储（SecretStorage），不会存入 settings.json。环境变量 ${picked.source.apiKeyEnv ?? '（未配置）'} 存在时仍以安全存储为准。`,
			password: true,
			ignoreFocusOut: true,
		});
		if (!key) {
			return;
		}
		await keys.store(picked.source.id, key.trim());
		syncByokSources();
		vscode.window.showInformationMessage(`已保存「${picked.source.label}」的 API Key。`);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('eva-ai.clearApiKey', async () => {
		const sources = readModelSources();
		if (!sources.length) {
			return;
		}
		const picked = await vscode.window.showQuickPick(
			sources.map(source => ({ label: source.label, description: source.baseUrl, source })),
			{ placeHolder: '要清除哪个模型来源已保存的 API Key？' },
		);
		if (!picked) {
			return;
		}
		await keys.clear(picked.source.id);
		syncByokSources();
		vscode.window.showInformationMessage(`已清除「${picked.source.label}」保存的 API Key（环境变量不受影响）。`);
	}));

	/**
	 * Answers the question a half-configured setup always leads to: is the key actually being found?
	 * Reports where each key came from without ever printing the key itself.
	 */
	context.subscriptions.push(vscode.commands.registerCommand('eva-ai.showModelSources', async () => {
		const sources = readModelSources();
		if (!sources.length) {
			vscode.window.showInformationMessage('没有配置任何自定义模型来源。');
			return;
		}
		const lines: string[] = [];
		for (const source of sources) {
			const stored = await context.secrets.get(`eva-ai.apiKey.${source.id}`);
			const fromEnv = source.apiKeyEnv ? process.env[source.apiKeyEnv] : undefined;
			const origin = stored ? 'SecretStorage' : fromEnv ? `环境变量 ${source.apiKeyEnv}` : source.staticApiKey ? '设置项（明文）' : '未找到';
			lines.push(`- ${source.label}（${source.id}）\n  端点：${source.baseUrl}\n  Key：${origin}`);
		}
		vscode.window.showInformationMessage(lines.join('\n'), { modal: true, detail: '密钥本身不会显示。' });
	}));

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
		if (e.affectsConfiguration('eva-ai')) {
			keys.invalidate();
			provider.refresh();
			syncByokSources();
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
		private readonly source: ModelSource,
		private readonly keys: ApiKeyResolver,
		private readonly auth: EvaAuthService,
		private readonly getConfig: () => EvaConfig,
	) {
		// Only the EVA gateway's model list rises and falls with the login state. A BYOK source
		// depends on nothing but its key, so watching the auth service would just refresh on
		// unrelated sign-ins.
		this.authListener = source.auth === 'oauth' ? auth.onDidChange(() => this.refresh()) : { dispose: () => { } };
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
		return this.source.auth === 'oauth'
			? this.provideEvaModels(options)
			: this.provideByokModels();
	}

	/**
	 * Models from a source we hold a key for.
	 *
	 * Discovery is attempted first and falls back to the configured list rather than failing: a
	 * self-hosted server that does not implement `/models` is still perfectly usable, and the user
	 * listing what it serves is a legitimate way to tell us about it. When neither works the source
	 * reports nothing, so a wrong address never blocks the rest of the picker.
	 */
	private async provideByokModels(): Promise<vscode.LanguageModelChatInformation[]> {
		const source = this.source;
		const apiKey = await this.keys.resolve(source);
		if (!apiKey) {
			return [];
		}
		const config = this.getConfig();

		const key = `${source.id}|${source.baseUrl}|${source.models.join(',')}|${config.maxInputTokens}|${config.maxOutputTokens}`;
		if (this.cachedModels && this.cacheKey === key) {
			return [...this.cachedModels];
		}

		let ids: readonly string[] = source.models;
		if (!ids.length) {
			try {
				const catalog = await fetchModels(source.baseUrl, apiKey);
				ids = catalog.ids;
			} catch (err) {
				vscode.window.showErrorMessage(`无法读取「${source.label}」的模型清单：${errorMessage(err)}`);
				return [];
			}
		}

		// No Auto entry here: only the EVA gateway tells us what its own default is, and inventing a
		// "let us pick" entry for a source we know nothing else about would be a guess.
		const ordered = orderModels(ids.filter(isChatModelId), '', undefined);
		const models: vscode.LanguageModelChatInformation[] = ordered.map(id => {
			const description = describeModel(id);
			const limits = limitsForEndpoint(source.baseUrl, id, config);
			return {
				id,
				name: description.name,
				family: description.family,
				version: MODEL_VERSION,
				detail: description.detail,
				tooltip: `${description.tooltip}\n\n来源：${source.label}\n端点：${source.baseUrl}`,
				maxInputTokens: limits.maxInputTokens,
				maxOutputTokens: limits.maxOutputTokens,
				capabilities: {
					// Vision is claimed for no BYOK model: none of these endpoints publish per-model
					// capabilities, and a vision claim that fails at request time looks like a broken
					// extension. Declare it per model once an endpoint can be asked.
					imageInput: false,
					toolCalling: true,
				},
				isBYOK: true,
			} satisfies EvaModelInformation;
		});

		this.cacheKey = key;
		this.cachedModels = models;
		return [...models];
	}

	private async provideEvaModels(options: vscode.PrepareLanguageModelChatModelOptions): Promise<vscode.LanguageModelChatInformation[]> {
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

	/**
	 * The key for a BYOK source, or a message naming the exact places it can be put.
	 *
	 * This is a request-time failure rather than a registration-time one on purpose: the picker
	 * samples sources constantly, and a source should stay visible (and configurable) even while its
	 * key is missing - only actually using it needs the key.
	 */
	private async requireApiKey(): Promise<string> {
		const key = await this.keys.resolve(this.source);
		if (!key) {
			const where = this.source.apiKeyEnv
				? `环境变量 ${this.source.apiKeyEnv}`
				: '设置项 `eva-ai.byok.sources` 的 apiKey / apiKeyEnv';
			throw new Error(`「${this.source.label}」没有可用的 API Key。请在 ${where} 中配置，或运行「Eva AI: 设置 API Key」写入安全存储。`);
		}
		return key;
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<EvaResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const config = this.getConfig();
		const accessToken = this.source.auth === 'oauth'
			? await this.requestAccessToken()
			: await this.requireApiKey();
		// The EVA address stays configurable per request; every other source uses the one it was
		// configured with, which is the whole point of declaring it.
		const baseUrl = this.source.auth === 'oauth' ? config.aiBaseUrl : this.source.baseUrl;

		const controller = new AbortController();
		const listener = token.onCancellationRequested(() => controller.abort());
		const targetId = this.resolveModelId(model.id);
		this.promptChars.set(targetId, JSON.stringify(messages).length);
		try {
			await streamChat({
				baseUrl,
				token: accessToken,
				source: this.source.id,
				model: targetId,
				messages,
				tools: options.tools,
				temperature: config.temperature,
				// Per model and per endpoint: asking for more than the service allows is a hard 400
				// ("Range of max_tokens should be [1, N]").
				maxOutputTokens: limitsForEndpoint(baseUrl, targetId, config).maxOutputTokens,
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
