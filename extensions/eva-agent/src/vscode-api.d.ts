/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference path="../../../src/vscode-dts/vscode.d.ts" />

// The API proposals this extension's types depend on, in dependency order:
// `chatSessionsProvider` types `ChatSession.history` with `ChatResponseTurn2`, which lives in
// `chatParticipantPrivate`, which in turn needs `chatParticipantAdditions`.
//
// Only `chatSessionsProvider` is listed in `enabledApiProposals`: the other two are referenced
// purely so the types resolve. Using them at runtime would mean taking on those proposals too.
// See the TODO on `EvaAgentSessions.provideContent`.
/// <reference path="../../../src/vscode-dts/vscode.proposed.languageModelThinkingPart.d.ts" />
/// <reference path="../../../src/vscode-dts/vscode.proposed.chatParticipantAdditions.d.ts" />
/// <reference path="../../../src/vscode-dts/vscode.proposed.chatParticipantPrivate.d.ts" />
/// <reference path="../../../src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts" />
