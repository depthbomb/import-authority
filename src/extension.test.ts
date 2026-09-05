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

function activateTestExtension(content = '', settings: Record<string, unknown> = {}) {
	let provider: vscode.CodeActionProvider;
	let metadata: vscode.CodeActionProviderMetadata;
	const commands = new Map<string, (...args: unknown[]) => unknown>();
	const disposable = { dispose() {} };
	const providerCalls: unknown[][] = [];
	const messages: string[] = [];
	const applied: Array<{ edits: Array<{ range: { start: number; end: number }; newText: string }> }> = [];
	const document = {
		uri: { scheme: 'file', fsPath: '/test.ts', toString: () => 'file:///test.ts' },
		languageId: 'typescript', fileName: '/test.ts', version: 1,
		getText: () => content, positionAt: (offset: number) => offset, offsetAt: (offset: number) => offset,
	};
	const api = {
		CodeActionKind: { SourceOrganizeImports: new Kind('source.organizeImports') },
		CodeAction: class { constructor(public title: string, public kind: Kind) {} },
		EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
		Range: class { constructor(public start: number, public end: number) {} },
		TextEdit: { replace: (range: unknown, newText: string) => ({ range, newText }) },
		WorkspaceEdit: class { edits: unknown[] = []; set(_uri: unknown, edits: unknown[]) { this.edits = edits; } },
		window: {
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
			registerTextDocumentContentProvider: () => disposable,
		},
		languages: {
			registerCodeActionsProvider: (_selector: unknown, registered: vscode.CodeActionProvider, meta: vscode.CodeActionProviderMetadata) => {
				provider = registered; metadata = meta; return disposable;
			},
			registerDocumentFormattingEditProvider: () => disposable,
		},
		commands: {
			registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => { commands.set(name, handler); return disposable; },
			executeCommand: async (...args: unknown[]) => { providerCalls.push(args); return []; },
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
	return { provider: provider!, metadata: metadata!, commands, providerCalls, messages, applied, document };
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
