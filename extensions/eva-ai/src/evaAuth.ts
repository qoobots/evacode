/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as vscode from 'vscode';
import type { EvaConfig } from './evaConfig';

/**
 * EVA IAM login: OAuth2 authorization code flow with PKCE (S256).
 *
 * Ported from eva-desktop (`apps/desktop-api/src/lib/iam.ts`, mirrored by `evawork/iam.py`).
 * Notable facts that shape this implementation:
 *  - the redirect target is a loopback HTTP listener owned by *us*; eva-desktop has the Electron
 *    main process open it and hands the URI to the login helper. Here we open it directly.
 *  - the token endpoint is form-encoded and the access token is opaque to us, so expiry comes
 *    from `expires_in` only (we never parse the JWT).
 *  - refresh is refreshed 60s early; if refresh fails the session is terminal and must be cleared,
 *    otherwise we would keep a "signed in" account that every request rejects with 401.
 */

const SESSION_SECRET_KEY = 'eva-ai.session';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const EXPIRY_SKEW_MS = 60 * 1000;
const CALLBACK_PATH = '/callback';
const SCOPE = 'openid profile';

export interface EvaAccountInfo {
	readonly username?: string;
	readonly realName?: string;
}

interface EvaSession {
	accessToken: string;
	refreshToken: string;
	/** Absolute epoch milliseconds. */
	expiresAt: number;
	account?: EvaAccountInfo;
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
}

function toPositiveNumber(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

export class EvaAuthService implements vscode.Disposable {

	private session: EvaSession | undefined;
	private refreshing: Promise<string> | undefined;

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly getConfig: () => EvaConfig,
	) { }

	dispose(): void {
		this._onDidChange.dispose();
	}

	/** Restore the persisted session. Credentials live in SecretStorage, never in settings. */
	async load(): Promise<void> {
		const raw = await this.secrets.get(SESSION_SECRET_KEY);
		if (!raw) {
			return;
		}
		try {
			const parsed = JSON.parse(raw) as Partial<EvaSession>;
			if (parsed && typeof parsed.accessToken === 'string' && parsed.accessToken) {
				this.session = {
					accessToken: parsed.accessToken,
					refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : '',
					expiresAt: toPositiveNumber(parsed.expiresAt) ?? 0,
					account: parsed.account,
				};
			}
		} catch (err) {
			console.error('eva-ai: stored session is unreadable, ignoring', err);
			this.session = undefined;
		}
	}

	get account(): EvaAccountInfo | undefined {
		return this.session?.account;
	}

	get isSignedIn(): boolean {
		return this.session?.accessToken !== undefined;
	}

	/**
	 * Returns a token that is not about to expire, refreshing silently when possible.
	 *
	 * Returns `undefined` when there is no usable session. Expired sessions whose refresh deems
	 * them terminal are cleared here so the UI can stop advertising models that would 401.
	 */
	/**
	 * Returns a token that is not about to expire, refreshing silently when needed.
	 *
	 * Returns `undefined` when there is no usable session and never throws, because callers include
	 * the model picker, which has to degrade to "no models" instead of surfacing an error dialog.
	 * A session whose refresh is terminal has already been cleared by {@link doRefresh}, so the next
	 * call correctly reports signed-out.
	 */
	async getAccessToken(): Promise<string | undefined> {
		const session = this.session;
		if (!session) {
			return undefined;
		}
		if (!this.isExpiringSoon(session)) {
			return session.accessToken;
		}
		try {
			return await this.refresh();
		} catch (err) {
			console.error('eva-ai: token refresh failed', err);
			return undefined;
		}
	}

	private isExpiringSoon(session: EvaSession): boolean {
		if (!session.expiresAt) {
			return false;
		}
		return session.expiresAt - EXPIRY_SKEW_MS <= Date.now();
	}

	/* ---------------- sign in / out ---------------- */

	/** Runs the full browser login. Resolves true on success. */
	async login(): Promise<boolean> {
		const config = this.getConfig();
		const verifier = crypto.randomBytes(32).toString('base64url');
		const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
		const state = crypto.randomBytes(24).toString('base64url');

		const { redirectUri, waitForCode, dispose } = await startCallbackServer(state);
		try {
			const params = new URLSearchParams({
				response_type: 'code',
				client_id: config.clientId,
				redirect_uri: redirectUri,
				scope: SCOPE,
				state,
				code_challenge: challenge,
				code_challenge_method: 'S256',
			});
			const authorizeUrl = vscode.Uri.parse(`${config.iamServerUrl}/iam/oauth2/authorize?${params.toString()}`);
			await vscode.env.openExternal(authorizeUrl);

			const code = await waitForCode;

			const tokens = await postForm<TokenResponse>(`${config.iamServerUrl}/iam/oauth2/token`, {
				grant_type: 'authorization_code',
				code,
				redirect_uri: redirectUri,
				client_id: config.clientId,
				code_verifier: verifier,
			});
			await this.storeTokens(tokens);
			return true;
		} finally {
			dispose();
		}
	}

	async logout(): Promise<void> {
		this.session = undefined;
		await this.secrets.delete(SESSION_SECRET_KEY);
		this._onDidChange.fire();
	}

	/* ---------------- refresh ---------------- */

	private async refresh(): Promise<string> {
		if (this.refreshing) {
			return this.refreshing;
		}
		this.refreshing = this.doRefresh();
		try {
			return await this.refreshing;
		} finally {
			this.refreshing = undefined;
		}
	}

	private async doRefresh(): Promise<string> {
		const session = this.session;
		const refreshToken = session?.refreshToken;
		if (!session || !refreshToken) {
			throw new Error('尚未登录 Eva AI');
		}
		try {
			const tokens = await postForm<TokenResponse>(`${this.getConfig().iamServerUrl}/iam/oauth2/token`, {
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
			});
			await this.storeTokens(tokens, session.account);
			return this.session!.accessToken;
		} catch (err) {
			// A rejected refresh is terminal - clear it rather than keep a session that 401s forever.
			this.session = undefined;
			await this.secrets.delete(SESSION_SECRET_KEY);
			this._onDidChange.fire();
			throw err instanceof Error ? err : new Error(String(err));
		}
	}

	private async storeTokens(tokens: TokenResponse, fallbackAccount?: EvaAccountInfo): Promise<void> {
		const accessToken = tokens.access_token;
		if (!accessToken) {
			throw new Error('EVA IAM 未返回 access_token');
		}
		const expiresIn = toPositiveNumber(tokens.expires_in) ?? 3600;
		const account = await this.fetchAccount(accessToken).catch(() => fallbackAccount);
		this.session = {
			accessToken,
			refreshToken: tokens.refresh_token ?? '',
			expiresAt: Date.now() + expiresIn * 1000,
			account,
		};
		await this.secrets.store(SESSION_SECRET_KEY, JSON.stringify(this.session));
		this._onDidChange.fire();
	}

	private async fetchAccount(accessToken: string): Promise<EvaAccountInfo | undefined> {
		const response = await fetch(`${this.getConfig().iamServerUrl}/iam/auth/me`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (!response.ok) {
			return undefined;
		}
		const body = await response.json() as { username?: string; realName?: string; real_name?: string };
		return {
			username: body.username,
			realName: body.realName ?? body.real_name,
		};
	}
}

/**
 * Opens a loopback listener that receives the authorization callback once.
 *
 * The server must be torn down in every exit path - including timeouts - otherwise a cancelled
 * login leaks a listening socket and the next attempt silently reuses a dead state.
 */
async function startCallbackServer(expectedState: string): Promise<{
	redirectUri: string;
	waitForCode: Promise<string>;
	dispose: () => void;
}> {
	const server = http.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});

	const port = await new Promise<number>(resolve => {
		const address = server.address();
		resolve(typeof address === 'object' && address ? address.port : 0);
	});
	if (!port) {
		server.close();
		throw new Error('无法在本机开启回调监听端口');
	}

	const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
	let timer: NodeJS.Timeout | undefined;
	let settled = false;

	const waitForCode = new Promise<string>((resolve, reject) => {
		const finish = (fn: () => void) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			fn();
		};

		timer = setTimeout(() => finish(() => reject(new Error('登录超时，未收到授权回调'))), LOGIN_TIMEOUT_MS);

		server.on('request', (req, res) => {
			const url = new URL(req.url ?? '/', redirectUri);
			if (url.pathname !== CALLBACK_PATH) {
				res.writeHead(404).end();
				return;
			}
			const error = url.searchParams.get('error');
			const code = url.searchParams.get('code');
			const state = url.searchParams.get('state');

			const respond = (status: number, html: string) => {
				res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
			};

			if (error) {
				respond(400, page('登录失败', error));
				finish(() => reject(new Error(`EVA IAM 返回错误：${error}`)));
				return;
			}
			if (!code) {
				respond(400, page('登录失败', '授权回调缺少 code'));
				finish(() => reject(new Error('授权回调缺少 code')));
				return;
			}
			if (state !== expectedState) {
				respond(400, page('登录失败', 'state 校验不通过'));
				finish(() => reject(new Error('登录会话校验失败（state 不匹配），请重新登录')));
				return;
			}
			respond(200, page('登录成功', '可以回到 Eva Code 了。'));
			finish(() => resolve(code));
		});
	});

	return {
		redirectUri,
		waitForCode,
		dispose: () => {
			if (timer) {
				clearTimeout(timer);
			}
			server.close();
		},
	};
}

function page(title: string, message: string): string {
	return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
		`<body style="font-family:sans-serif;padding:2rem"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></body></html>`;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, c => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	}[c]!));
}

async function postForm<T>(url: string, data: Record<string, string>): Promise<T> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(data).toString(),
		});
	} catch (err) {
		throw new Error(`连不上 EVA 服务（${url}）：${err instanceof Error ? err.message : String(err)}`);
	}

	const text = await response.text();
	let body: Record<string, unknown> = {};
	try {
		body = text ? JSON.parse(text) as Record<string, unknown> : {};
	} catch {
		body = {};
	}

	const maybeError = body.error_description ?? body.error ?? body.message;
	if (!response.ok || typeof maybeError === 'string') {
		throw new Error(typeof maybeError === 'string' && maybeError ? maybeError : `EVA 服务返回 HTTP ${response.status}`);
	}
	return body as unknown as T;
}
