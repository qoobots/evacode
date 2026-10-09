/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { EvaAuthService } from './evaAuth';

const SCOPES: readonly string[] = ['openid', 'profile'];

/**
 * Surfaces the EVA login as an account in the accounts menu.
 *
 * This is a thin view over {@link EvaAuthService}, not a second source of truth: the language model
 * provider and the account must never disagree about whether the user is signed in. Signing in or
 * out from the menu goes through the same service, and its change event is what refreshes both the
 * account row and the model list.
 */
export class EvaAuthenticationProvider implements vscode.AuthenticationProvider, vscode.Disposable {

	private readonly _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private session: vscode.AuthenticationSession | undefined;
	private readonly listener: vscode.Disposable;

	constructor(private readonly auth: EvaAuthService) {
		this.listener = auth.onDidChange(() => void this.sync());
	}

	dispose(): void {
		this.listener.dispose();
		this._onDidChangeSessions.dispose();
	}

	async getSessions(): Promise<vscode.AuthenticationSession[]> {
		await this.sync();
		return this.session ? [this.session] : [];
	}

	async createSession(): Promise<vscode.AuthenticationSession> {
		// Rejects on failure, which is what the accounts menu expects to abort the sign-in.
		await this.auth.login();
		await this.sync();
		if (!this.session) {
			throw new Error('EVA 登录成功，但未取得账号信息');
		}
		return this.session;
	}

	async removeSession(): Promise<void> {
		await this.auth.logout();
	}

	/**
	 * Recomputes the session and fires only on an actual sign-in/sign-out transition.
	 *
	 * Token refresh alone must not fire: it changes the access token but not the account, and firing
	 * would make the accounts menu flicker every time a token is renewed.
	 */
	private async sync(): Promise<void> {
		const previous = this.session;
		this.session = await this.buildSession();
		if (previous?.id === this.session?.id) {
			return;
		}
		this._onDidChangeSessions.fire({
			added: this.session ? [this.session] : undefined,
			removed: previous ? [previous] : undefined,
			changed: undefined,
		});
	}

	private async buildSession(): Promise<vscode.AuthenticationSession | undefined> {
		const accessToken = await this.auth.getAccessToken();
		if (!accessToken) {
			return undefined;
		}
		const account = this.auth.account;
		const id = account?.username || 'eva';
		return {
			id,
			accessToken,
			account: { id, label: account?.realName || account?.username || 'EVA' },
			scopes: [...SCOPES],
		};
	}
}
