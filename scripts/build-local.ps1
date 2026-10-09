# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

<#
.SYNOPSIS
	Runs an evacode build step with the environment corrections this machine needs.

.DESCRIPTION
	A terminal opened by the CodeBuddy JetBrains plugin (coding-copilot-jetbrains, which
	drives the `fusion` shell agent) is launched with three settings that break a build:

		NODE_ENV=production              npm resolves omit=dev and silently skips every
		                                 devDependency, so node-gyp and friends never get
		                                 installed and preinstall dies looking for them.
		NODE_OPTIONS=--require=<shim>    wraps fs.rm with a bulk-delete guard that aborts
		                                 npm install and postinstall once a directory holds
		                                 more than 500 entries.
	signtool.exe not on PATH            patchWin32Dependencies spawns it by name; it ships
		                                 with the Windows SDK.

	The network in front of this machine also intercepts TLS, which Node rejects with
	UNABLE_TO_VERIFY_LEAF_SIGNATURE ("TypeError: fetch failed") even though PowerShell
	downloads fine. `--use-system-ca` makes Node validate against the Windows certificate
	store, and it replaces the injected shim rather than stacking on top of it.

	Those variables are set by the IDE process tree, not by the registry, so they cannot
	be removed from outside it. This script corrects them for the child processes it
	starts and leaves every machine-wide and IDE setting untouched.

.PARAMETER Step
	install     Sync dependencies (same as `npm run install-fast -- --force`).
	compile     Transpile client, built-in extensions and copilot (same as `npm run build-fast`).
	package     Produce the Windows x64 build in ../VSCode-win32-x64 (same as
	            `npm run gulp vscode-win32-x64`). That directory is deleted and recreated.
	package-ci  Only the packaging tail: native extensions, packaging, copilot shim and
	            binary patching. Skips the extension compile and the client bundle, so it
	            only reflects what those earlier steps already wrote.
	all         install, compile and package (default).

.PARAMETER NpmArgs
	Extra arguments appended to the npm invocation. Used by install and compile only.

.EXAMPLE
	./scripts/build-local.ps1 compile
	./scripts/build-local.ps1 package
	./scripts/build-local.ps1 install --no-audit
#>
param(
	[ValidateSet('install', 'compile', 'package', 'package-ci', 'all')]
	[string]$Step = 'all',

	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]]$NpmArgs
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

# Keep the IDE's language-service hooks but stop inheriting the delete guard. `--use-system-ca`
# is required on top of that: without it every download step fails on the intercepted TLS chain.
if ($env:NODE_OPTIONS -match 'node-language-shim|node-safe-delete-shim') {
	$env:NODE_OPTIONS = '--use-system-ca'
}
elseif ($env:NODE_OPTIONS -notmatch '--use-system-ca') {
	$env:NODE_OPTIONS = "$($env:NODE_OPTIONS.Trim()) --use-system-ca".Trim()
}

# `production` makes npm drop devDependencies, which is never what a source build wants.
$env:NODE_ENV = 'development'

if ($env:OS -eq 'Windows_NT') {
	# Newest Windows SDK on the machine, so this keeps working after a SDK update.
	$signTool = Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Filter 'signtool.exe' -Recurse -ErrorAction SilentlyContinue |
		Where-Object { $_.Directory.Name -eq 'x64' } |
		Sort-Object -Property FullName -Descending |
		Select-Object -First 1

	if ($signTool) {
		$env:PATH = "$($signTool.Directory);$env:PATH"
	}
	elseif ($Step -in @('package', 'all')) {
		Write-Warning 'signtool.exe was not found. Install the Windows SDK, or packaging will fail in patchWin32Dependencies.'
	}
}

function Invoke-BuildStep([string]$Description, [string[]]$Arguments) {
	Write-Host "`n:: $Description" -ForegroundColor Green
	Write-Host "   npm $($Arguments -join ' ')`n"

	# npm reports progress and warnings on stderr, which Windows PowerShell surfaces as
	# NativeCommandError records. Render them as plain text so the output stays readable
	# and only the exit code decides whether the step failed.
	$ErrorActionPreference = 'Continue'
	try {
		& npm @Arguments 2>&1 | ForEach-Object { Write-Host $_ }
		$exitCode = $LASTEXITCODE
	}
	finally {
		$ErrorActionPreference = 'Stop'
	}

	if ($exitCode -ne 0) {
		Write-Host ":: $Description failed with exit code $exitCode" -ForegroundColor Red
		exit $exitCode
	}
}

$installArgs = @('run', 'install-fast', '--', '--force') + $NpmArgs
$compileArgs = @('run', 'build-fast') + $NpmArgs
$packageArgs = @('run', 'gulp', 'vscode-win32-x64')
$packageCiArgs = @('run', 'gulp', 'vscode-win32-x64-ci')

switch ($Step) {
	'install' { Invoke-BuildStep 'Syncing dependencies' $installArgs }
	'compile' { Invoke-BuildStep 'Compiling client, built-in extensions and copilot' $compileArgs }
	'package' { Invoke-BuildStep 'Packaging Windows x64' $packageArgs }
	'package-ci' { Invoke-BuildStep 'Packaging Windows x64 (tail only)' $packageCiArgs }
	'all' {
		Invoke-BuildStep 'Syncing dependencies' $installArgs
		Invoke-BuildStep 'Compiling client, built-in extensions and copilot' $compileArgs
		Write-Host "`n:: Packaging deletes and recreates ../VSCode-win32-x64" -ForegroundColor Yellow
		Invoke-BuildStep 'Packaging Windows x64' $packageArgs
	}
}

if ($Step -in @('package', 'package-ci', 'all')) {
	# The build lands beside the repository, not inside it: `../VSCode-win32-x64` relative to the
	# repo root, which is the parent of $PSScriptRoot's own parent.
	$buildDir = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'VSCode-win32-x64'
	if (Test-Path $buildDir) {
		Write-Host "`n:: Build ready in $(Resolve-Path $buildDir)" -ForegroundColor Green
	}
	else {
		Write-Warning "Packaging did not produce $buildDir."
	}
}
