import ts from 'typescript';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import type * as vscode from 'vscode';

class Kind {
	constructor(public value: string) {}
	append(value: string): Kind { return new Kind(`${this.value}.${value}`); }
	contains(other: Kind): boolean { return other.value === this.value || other.value.startsWith(`${this.value}.`); }
}

function activateTestExtension(content = '', settings: Record<string, unknown> = {}, execute?: (...args: unknown[]) => unknown) {
	let provider: vscode.CodeActionProvider;
	let metadata: vscode.CodeActionProviderMetadata;
	const commands = new Map<string, (...args: unknown[]) => unknown>();
	const disposable = { dispose() {} };
	const providerCalls: unknown[][] = [];
	const messages: string[] = [];
	const logs: string[] = [];
	let outputShown = false;
	let previewProvider: vscode.TextDocumentContentProvider;
	let formattingProvider: vscode.DocumentFormattingEditProvider;
	const applied: Array<{ edits: Array<{ range: { start: number; end: number }; newText: string }> }> = [];
	const document = {
		uri: { scheme: 'file', fsPath: '/test.ts', toString: () => 'file:///test.ts' },
		languageId: 'typescript', fileName: '/test.ts', version: 1,
		getText: () => content, positionAt: (offset: number) => offset, offsetAt: (offset: number) => offset,
	};
	const api = {
		Uri: { from: (parts: { scheme: string; path: string }) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}` }) },
		CodeActionKind: { SourceOrganizeImports: new Kind('source.organizeImports') },
		CodeAction: class { constructor(public title: string, public kind: Kind) {} },
		EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
		Range: class { constructor(public start: number, public end: number) {} },
		TextEdit: { replace: (range: unknown, newText: string) => ({ range, newText }) },
		WorkspaceEdit: class { edits: unknown[] = []; set(_uri: unknown, edits: unknown[]) { this.edits = edits; } },
		window: {
			createOutputChannel: () => ({ ...disposable, appendLine: (line: string) => logs.push(line), show: () => { outputShown = true; } }),
			activeTextEditor: { document },
			showWarningMessage: (message: string) => { messages.push(message); },
			showErrorMessage: (message: string) => { messages.push(message); },
			showInformationMessage: (message: string) => { messages.push(message); },
		},
		workspace: {
			getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? (key === 'sorting.detectPathAliases' ? false : fallback) }),
			openTextDocument: async () => document,
			applyEdit: async (edit: typeof applied[number]) => { applied.push(edit); return true; },
			createFileSystemWatcher: () => ({ ...disposable, onDidCreate: () => disposable, onDidChange: () => disposable, onDidDelete: () => disposable }),
			onDidCloseTextDocument: () => disposable,
			registerTextDocumentContentProvider: (_scheme: string, registered: vscode.TextDocumentContentProvider) => { previewProvider = registered; return disposable; },
		},
		languages: {
			registerCodeActionsProvider: (_selector: unknown, registered: vscode.CodeActionProvider, meta: vscode.CodeActionProviderMetadata) => {
				provider = registered; metadata = meta; return disposable;
			},
			registerDocumentFormattingEditProvider: (_selector: unknown, registered: vscode.DocumentFormattingEditProvider) => { formattingProvider = registered; return disposable; },
		},
		commands: {
			registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => { commands.set(name, handler); return disposable; },
			executeCommand: async (...args: unknown[]) => { providerCalls.push(args); return execute ? execute(...args) : []; },
		},
	};
	const filename = `${process.cwd()}/src/extension.ts`;
	const localRequire = createRequire(filename);
	const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
	}).outputText;
	const extension = { exports: {} as { activate(context: unknown): void } };
	runInThisContext(`(function(require, module, exports) {${compiled}\n})`, { filename })(
		(name: string) => name === 'vscode' ? api : localRequire(name), extension, extension.exports,
	);
	extension.exports.activate({ subscriptions: [] });
	return {
		provider: provider!, metadata: metadata!, commands, providerCalls, messages, applied, document,
		logs, outputShown: () => outputShown, previewProvider: previewProvider!, formattingProvider: formattingProvider!,
	};
}

test('registers a dedicated save action that also responds to generic organize requests', () => {
	const { provider, metadata, commands } = activateTestExtension();
	assert.deepEqual(metadata.providedCodeActionKinds?.map(kind => kind.value), ['source.organizeImports.importAuthority']);
	const document = { uri: { scheme: 'file', fsPath: '/test.ts' }, languageId: 'typescript' } as vscode.TextDocument;
	for (const filter of [undefined, 'source', 'source.organizeImports', 'source.organizeImports.importAuthority']) {
		const actions = provider.provideCodeActions!(document, {} as vscode.Range, {
			only: filter ? new Kind(filter) : undefined, diagnostics: [],
		} as unknown as vscode.CodeActionContext, {} as vscode.CancellationToken) as vscode.CodeAction[];
		assert.equal(actions.length, 1);
		assert.equal(actions[0].kind?.value, 'source.organizeImports.importAuthority');
		assert.ok(commands.has(actions[0].command!.command));
		assert.deepEqual(actions[0].command!.arguments, [document.uri]);
	}
	for (const filter of ['source.fixAll', 'source.organizeImports.other']) {
		assert.deepEqual(provider.provideCodeActions!(document, {} as vscode.Range, {
			only: new Kind(filter), diagnostics: [],
		} as unknown as vscode.CodeActionContext, {} as vscode.CancellationToken), []);
	}
});

test('manual commands explain unchanged files and skipped syntax without calling removal providers', async () => {
	for (const [content, expected] of [
		["import { A } from 'a';\n", 'already organized'],
		['const a = 1;\n', 'No import declarations'],
		["import { from 'a';\n", 'Syntax errors'],
		["// import-authority-ignore-file\nimport { B, A } from 'a';\n", 'File skipped'],
	]) {
		const extension = activateTestExtension(content);
		await extension.commands.get('import-authority.organizeImports')!();
		assert.match(extension.messages.join('\n'), new RegExp(expected));
		assert.equal(extension.applied.length, 0);
	}
	const malformed = activateTestExtension("import { from 'a';", { 'unusedImports.useBuiltInRemoval': true });
	await malformed.commands.get('import-authority.organizeImports')!();
	assert.equal(malformed.providerCalls.length, 0);
});

test('preview and explain show counts without applying edits or executing provider commands', async () => {
	const content = "import { LongName } from 'long';\nimport { A } from 'a';\nimport { B } from 'long';\n";
	const extension = activateTestExtension(content);
	await extension.commands.get('import-authority.previewOrganizeImports')!();
	const diff = extension.providerCalls.find(call => call[0] === 'vscode.diff')!;
	assert.match(String(diff[3]), /1 merged, 2 moved, 0 bindings removed/);
	assert.equal(extension.previewProvider.provideTextDocumentContent(diff[2] as vscode.Uri, {} as vscode.CancellationToken), "import { A } from 'a';\nimport { B, LongName } from 'long';\n");
	await extension.commands.get('import-authority.explainImports')!();
	assert.ok(extension.outputShown());
	assert.equal(extension.applied.length, 0);
	assert.match(extension.logs.at(-1)!, /proposed.*1 merged, 2 moved/);
});

test('reports unavailable and failed providers and counts fallback removals', async () => {
	const content = "import { Keep, Unused } from 'a';\nconsole.log(Keep);\n";
	for (const fail of [false, true]) {
		const extension = activateTestExtension(content, {
			'unusedImports.useBuiltInRemoval': true, 'unusedImports.useFallbackRemoval': true,
		}, () => { if (fail) { throw new Error('provider failed'); } return []; });
		await extension.commands.get('import-authority.explainImports')!();
		assert.match(extension.logs[0], /1 binding removed/);
		assert.match(extension.logs[0], fail ? /provider failed/ : /No compatible unused-import provider/);
		assert.match(extension.logs[0], /Heuristic unused-import removal applied/);
		assert.equal(extension.applied.length, 0);
	}
});

test('save actions and formatting log reports without notifications', async () => {
	const extension = activateTestExtension("import { B, A } from 'a';\n", { 'features.enableFormattingProvider': true });
	await extension.commands.get('import-authority.organizeImports')!(extension.document.uri);
	await extension.formattingProvider.provideDocumentFormattingEdits(extension.document as unknown as vscode.TextDocument, {} as vscode.FormattingOptions, {} as vscode.CancellationToken);
	assert.equal(extension.messages.length, 0);
	assert.equal(extension.logs.length, 2);
	assert.equal(extension.applied.length, 1);
});

test('provider reports distinguish no changes from removal and keep explanation read-only', async () => {
	const content = "import { Unused } from 'a';\n";
	for (const remove of [false, true]) {
		const extension = activateTestExtension(content, { 'unusedImports.useBuiltInRemoval': true }, (...args) => [{
			title: 'Remove unused imports', kind: { value: args[3] },
			edit: { get: () => remove ? [{ range: { start: 0, end: content.length }, newText: '' }] : [] },
			command: { command: 'provider.sideEffect', title: 'Do not run' },
		}]);
		await extension.commands.get('import-authority.explainImports')!();
		assert.match(extension.logs[0], remove ? /1 binding removed/ : /returned no unused-import changes/);
		assert.doesNotMatch(extension.logs[0], /provider was available/);
		assert.equal(extension.applied.length, 0);
		assert.ok(extension.providerCalls.every(call => call[0] === 'vscode.executeCodeActionProvider'));
	}
});

test('JSX fallback skips and stale provider results produce accurate reports', async () => {
	const extension = activateTestExtension("import React from 'react';\nconst view = <div />;\n", {
		'unusedImports.useBuiltInRemoval': true, 'unusedImports.useFallbackRemoval': true,
	});
	extension.document.uri.fsPath = '/test.tsx';
	extension.document.languageId = 'typescriptreact';
	await extension.commands.get('import-authority.explainImports')!();
	assert.match(extension.logs[0], /Heuristic removal skipped/);
	assert.match(extension.logs[0], /0 bindings removed/);
	const stale = activateTestExtension("import A from 'a';\n", { 'unusedImports.useBuiltInRemoval': true }, () => {
		stale.document.version += 1;
		return [];
	});
	await stale.commands.get('import-authority.explainImports')!();
	assert.equal(stale.logs.length, 0);
	assert.equal(stale.applied.length, 0);
	assert.match(stale.messages[0], /document changed/);
});

test('directives bypass external removal and preserve pinned imports during fallback removal', async () => {
	const pinned = '// import-authority-pin\nimport { Keep, Longer } from "long";\n';
	const content = `${pinned}import { Unused } from 'unused';\n`;
	const extension = activateTestExtension(content, {
		'unusedImports.useBuiltInRemoval': true, 'unusedImports.useFallbackRemoval': true,
	});
	await extension.commands.get('import-authority.organizeImports')!();
	assert.equal(extension.providerCalls.length, 0);
	let result = content;
	for (const edit of extension.applied.flatMap(change => change.edits)) {
		result = result.slice(0, edit.range.start) + edit.newText + result.slice(edit.range.end);
	}
	assert.equal(result, pinned);
	const ignored = activateTestExtension(`// import-authority-ignore-file\n${content}`, { 'unusedImports.useBuiltInRemoval': true });
	await ignored.commands.get('import-authority.organizeImports')!();
	assert.equal(ignored.providerCalls.length, 0);
	assert.equal(ignored.applied.length, 0);
});

test('type-import conversion is enabled by default, configurable and read-only in previews', async () => {
	const content = "import { Model, run } from 'pkg';\nlet value: Model; run();\n";
	for (const enabled of [true, false]) {
		const extension = activateTestExtension(content, enabled ? {} : { 'typeImports.convertTypeOnlyImports': false });
		await extension.commands.get('import-authority.explainImports')!();
		assert.equal(extension.applied.length, 0);
		if (enabled) { assert.match(extension.logs[0], /1 converted to type imports/); }
		else { assert.doesNotMatch(extension.logs[0], /converted to type imports/); }
		await extension.commands.get('import-authority.organizeImports')!();
		let result = content;
		for (const edit of extension.applied.flatMap(change => change.edits)) {
			result = result.slice(0, edit.range.start) + edit.newText + result.slice(edit.range.end);
		}
		assert.equal(result.includes("import type { Model } from 'pkg';"), enabled);
	}
	const preview = activateTestExtension(content, {
		'unusedImports.useBuiltInRemoval': true, 'unusedImports.useFallbackRemoval': true,
	});
	await preview.commands.get('import-authority.previewOrganizeImports')!();
	const diff = preview.providerCalls.find(call => call[0] === 'vscode.diff')!;
	assert.match(String(diff[3]), /1 converted to type imports/);
	assert.match(String(preview.previewProvider.provideTextDocumentContent(diff[2] as vscode.Uri, {} as vscode.CancellationToken)), /import type \{ Model \}/);
	assert.equal(preview.applied.length, 0);
});
