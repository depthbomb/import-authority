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

function activateTestExtension() {
	let provider: vscode.CodeActionProvider;
	let metadata: vscode.CodeActionProviderMetadata;
	const commands = new Map<string, (...args: unknown[]) => unknown>();
	const disposable = { dispose() {} };
	const api = {
		CodeActionKind: { SourceOrganizeImports: new Kind('source.organizeImports') },
		CodeAction: class { constructor(public title: string, public kind: Kind) {} },
		EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
		workspace: {
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
		commands: { registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => { commands.set(name, handler); return disposable; } },
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
	return { provider: provider!, metadata: metadata!, commands };
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
