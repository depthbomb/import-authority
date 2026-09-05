import ts from 'typescript';
import { dirname } from 'node:path';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { runInThisContext } from 'node:vm';
import { createRequire } from 'node:module';
import type * as vscode from 'vscode';

class Kind {
	public constructor(public value: string) {
	}

	public append(value: string): Kind {
		return new Kind(`${this.value}.${value}`);
	}

	public contains(other: Kind): boolean {
		return other.value === this.value || other.value.startsWith(`${this.value}.`);
	}
}

function activateTestExtension(content = '', settings: Record<string, unknown> = {}, execute?: (...args: unknown[]) => unknown) {
	let provider: vscode.CodeActionProvider;
	let metadata: vscode.CodeActionProviderMetadata;

	const commands = new Map<string, (...args: unknown[]) => unknown>();
	const disposable = {
		dispose() {
		}
	};
	const providerCalls = [] as unknown[][];
	const messages      = [] as string[];
	const logs          = [] as string[];
	const diagnostics   = new Map<string, vscode.Diagnostic[]>();
	const events        = new Map<string, (event: any) => void>();
	const on = (name: string) => (handler: (event: any) => void) => {
		const previous = events.get(name);
		events.set(name, event => {
			previous?.(event);
			handler(event);
		});

		return disposable;
	};
	const documents = [] as vscode.TextDocument[];

	let outputShown = false;
	let previewProvider: vscode.TextDocumentContentProvider;
	let formattingProvider: vscode.DocumentFormattingEditProvider;

	const applied = [] as Array<{ edits: Array<{ range: { start: number; end: number; }; newText: string; }>; }>;
	const document = {
		uri:        {
			scheme:   'file',
			fsPath:   '/test.ts',
			toString: () => 'file:///test.ts'
		},
		languageId: 'typescript',
		fileName:   '/test.ts',
		version:    1,
		getText:    () => content,
		positionAt: (offset: number) => offset,
		offsetAt:   (offset: number) => offset,
	};

	const api = {
		Uri:                   {
			from: (parts: { scheme: string; path: string; }) => ({
				...parts,
				toString: () => `${parts.scheme}:${parts.path}`
			})
		},
		CodeActionKind:        {
			SourceOrganizeImports: new Kind('source.organizeImports'),
			QuickFix:              new Kind('quickfix'),
			RefactorRewrite:       new Kind('refactor.rewrite')
		},
		CodeActionTriggerKind: {
			Invoke: 1
		},
		DiagnosticSeverity:    {
			Information: 2
		},
		Diagnostic:            class {
			public constructor(public range: unknown, public message: string, public severity: number) {
			}
		},
		CodeAction:            class {
			public constructor(public title: string, public kind: Kind) {
			}
		},
		EventEmitter:          class {
			public event = () => disposable;

			public fire() {
			}

			public dispose() {
			}
		},
		Range:                 class {
			public constructor(public start: number, public end: number) {
			}
		},
		TextEdit:              {
			replace: (range: unknown, newText: string) => ({
				range,
				newText
			})
		},
		WorkspaceEdit:         class {
			public edits: unknown[] = [];

			public set(_uri: unknown, edits: unknown[]) {
				this.edits = edits;
			}
		},
		window:                {
			showQuickPick:          async (items: unknown[]) => items[0],
			createOutputChannel:    () => ({
				...disposable,
				appendLine: (line: string) => logs.push(line),
				show:       () => {
					outputShown = true;
				}
			}),
			activeTextEditor:       {
				document
			},
			showWarningMessage:     (message: string) => {
				messages.push(message);
			},
			showErrorMessage:       (message: string) => {
				messages.push(message);
			},
			showInformationMessage: (message: string) => {
				messages.push(message);
			},
		},
		workspace:             {
			textDocuments:                       documents,
			onDidOpenTextDocument:               on('open'),
			onDidChangeTextDocument:             on('change'),
			onDidChangeConfiguration:            on('config'),
			getConfiguration:                    () => ({
				get: (key: string, fallback: unknown) => settings[key] ?? (key === 'sorting.detectPathAliases' ? false : fallback)
			}),
			openTextDocument:                    async () => document,
			applyEdit:                           async (edit: typeof applied[number]) => {
				applied.push(edit);

				return true;
			},
			createFileSystemWatcher:             () => ({
				...disposable,
				onDidCreate: () => disposable,
				onDidChange: () => disposable,
				onDidDelete: () => disposable
			}),
			onDidCloseTextDocument:              on('close'),
			registerTextDocumentContentProvider: (_scheme: string, registered: vscode.TextDocumentContentProvider) => {
				previewProvider = registered;

				return disposable;
			},
		},
		languages:             {
			createDiagnosticCollection:             () => ({
				set:     (uri: vscode.Uri, values: vscode.Diagnostic[]) => diagnostics.set(uri.toString(), values),
				get:     (uri: vscode.Uri) => diagnostics.get(uri.toString()),
				delete:  (uri: vscode.Uri) => diagnostics.delete(uri.toString()),
				dispose: () => diagnostics.clear(),
			}),
			registerCodeActionsProvider:            (_selector: unknown, registered: vscode.CodeActionProvider, meta: vscode.CodeActionProviderMetadata) => {
				provider = registered;
				metadata = meta;

				return disposable;
			},
			registerDocumentFormattingEditProvider: (_selector: unknown, registered: vscode.DocumentFormattingEditProvider) => {
				formattingProvider = registered;

				return disposable;
			},
		},
		commands:              {
			registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => {
				commands.set(name, handler);

				return disposable;
			},
			executeCommand:  async (...args: unknown[]) => {
				providerCalls.push(args);

				return execute ? execute(...args) : [];
			},
		},
	};

	const filename     = process.env.IMPORT_AUTHORITY_TEST_BUNDLE ?? `${process.cwd()}/src/extension.ts`;
	const localRequire = createRequire(filename);
	const compiled = process.env.IMPORT_AUTHORITY_TEST_BUNDLE
		? readFileSync(filename, 'utf8')
		: ts.transpileModule(readFileSync(filename, 'utf8'), {
			compilerOptions: {
				module:          ts.ModuleKind.CommonJS,
				target:          ts.ScriptTarget.ES2022,
				esModuleInterop: true
			},
		}).outputText;

	const extension = {
		exports: {} as { activate(context: unknown): void; }
	};
	runInThisContext(`(function(require, module, exports, __filename, __dirname) {${compiled}\n})`, {
		filename
	})(
		(name: string) => name === 'vscode' ? api : localRequire(name), extension, extension.exports, filename, dirname(filename),
	);

	const subscriptions = [] as vscode.Disposable[];
	extension.exports.activate({
		subscriptions
	});

	return {
		provider: provider!,
		metadata: metadata!,
		commands,
		providerCalls,
		messages,
		applied,
		document,
		logs,
		outputShown:        () => outputShown,
		previewProvider:    previewProvider!,
		formattingProvider: formattingProvider!,
		diagnostics,
		events,
		documents,
		dispose: () => subscriptions.forEach(subscription => subscription.dispose()),
	};
}

test('registers a dedicated save action that also responds to generic organize requests', () => {
	const { provider, metadata, commands } = activateTestExtension();
	assert.deepEqual(metadata.providedCodeActionKinds?.map(kind => kind.value), ['source.organizeImports.importAuthority', 'quickfix', 'refactor.rewrite.importAuthority.namespace']);

	const document = {
		uri:        {
			scheme: 'file',
			fsPath: '/test.ts'
		},
		languageId: 'typescript'
	} as vscode.TextDocument;

	for (const filter of [undefined, 'source', 'source.organizeImports', 'source.organizeImports.importAuthority']) {
		const actions = provider.provideCodeActions!(document, {} as vscode.Range, {
			only:        filter ? new Kind(filter) : undefined,
			diagnostics: [],
		} as unknown as vscode.CodeActionContext, {} as vscode.CancellationToken) as vscode.CodeAction[];
		assert.equal(actions.length, 1);
		assert.equal(actions[0].kind?.value, 'source.organizeImports.importAuthority');
		assert.ok(commands.has(actions[0].command!.command));
		assert.deepEqual(actions[0].command!.arguments, [document.uri]);
	}

	for (const filter of ['source.fixAll', 'source.organizeImports.other']) {
		assert.deepEqual(provider.provideCodeActions!(document, {} as vscode.Range, {
			only:        new Kind(filter),
			diagnostics: [],
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

	const malformed = activateTestExtension("import { from 'a';", {
		'unusedImports.useBuiltInRemoval': true
	});
	await malformed.commands.get('import-authority.organizeImports')!();
	assert.equal(malformed.providerCalls.length, 0);
});

test('preview and explain show counts without applying edits or executing provider commands', async () => {
	const content   = "import { LongName } from 'long';\nimport { A } from 'a';\nimport { B } from 'long';\n";
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
			'unusedImports.useBuiltInRemoval':  true,
			'unusedImports.useFallbackRemoval': true,
		}, () => {
			if (fail) {
				throw new Error('provider failed');
			}

			return [];
		});
		await extension.commands.get('import-authority.explainImports')!();
		assert.match(extension.logs[0], /1 binding removed/);
		assert.match(extension.logs[0], fail ? /provider failed/ : /No compatible unused-import provider/);
		assert.match(extension.logs[0], /Heuristic unused-import removal applied/);
		assert.equal(extension.applied.length, 0);
	}
});

test('save actions and formatting log reports without notifications', async () => {
	const extension = activateTestExtension("import { B, A } from 'a';\n", {
		'features.enableFormattingProvider': true
	});
	await extension.commands.get('import-authority.organizeImports')!(extension.document.uri);
	await extension.formattingProvider.provideDocumentFormattingEdits(extension.document as unknown as vscode.TextDocument, {} as vscode.FormattingOptions, {} as vscode.CancellationToken);
	assert.equal(extension.messages.length, 0);
	assert.equal(extension.logs.length, 2);
	assert.equal(extension.applied.length, 1);
});

test('provider reports distinguish no changes from removal and keep explanation read-only', async () => {
	const content = "import { Unused } from 'a';\n";

	for (const remove of [false, true]) {
		const extension = activateTestExtension(content, {
			'unusedImports.useBuiltInRemoval': true
		}, (...args) => [{
			title:   'Remove unused imports',
			kind:    {
				value: args[3]
			},
			edit:    {
				get: () => remove ? [{
					range:   {
						start: 0,
						end:   content.length
					},
					newText: ''
				}] : []
			},
			command: {
				command: 'provider.sideEffect',
				title:   'Do not run'
			},
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
		'unusedImports.useBuiltInRemoval':  true,
		'unusedImports.useFallbackRemoval': true,
	});
	extension.document.uri.fsPath = '/test.tsx';
	extension.document.languageId = 'typescriptreact';
	await extension.commands.get('import-authority.explainImports')!();
	assert.match(extension.logs[0], /Heuristic removal skipped/);
	assert.match(extension.logs[0], /0 bindings removed/);

	const stale = activateTestExtension("import A from 'a';\n", {
		'unusedImports.useBuiltInRemoval': true
	}, () => {
		stale.document.version += 1;

		return [];
	});
	await stale.commands.get('import-authority.explainImports')!();
	assert.equal(stale.logs.length, 0);
	assert.equal(stale.applied.length, 0);
	assert.match(stale.messages[0], /document changed/);
});

test('directives bypass external removal and preserve pinned imports during fallback removal', async () => {
	const pinned  = '// import-authority-pin\nimport { Keep, Longer } from "long";\n';
	const content = `${pinned}import { Unused } from 'unused';\n`;
	const extension = activateTestExtension(content, {
		'unusedImports.useBuiltInRemoval':  true,
		'unusedImports.useFallbackRemoval': true,
	});
	await extension.commands.get('import-authority.organizeImports')!();
	assert.equal(extension.providerCalls.length, 0);

	let result = content;

	for (const edit of extension.applied.flatMap(change => change.edits)) {
		result = result.slice(0, edit.range.start) + edit.newText + result.slice(edit.range.end);
	}

	assert.equal(result, pinned);

	const ignored = activateTestExtension(`// import-authority-ignore-file\n${content}`, {
		'unusedImports.useBuiltInRemoval': true
	});
	await ignored.commands.get('import-authority.organizeImports')!();
	assert.equal(ignored.providerCalls.length, 0);
	assert.equal(ignored.applied.length, 0);
});

test('type-import conversion is enabled by default, configurable and read-only in previews', async () => {
	const content = "import { Model, run } from 'pkg';\nlet value: Model; run();\n";

	for (const enabled of [true, false]) {
		const extension = activateTestExtension(content, enabled ? {} : {
			'typeImports.convertTypeOnlyImports': false
		});
		await extension.commands.get('import-authority.explainImports')!();
		assert.equal(extension.applied.length, 0);

		if (enabled) {
			assert.match(extension.logs[0], /1 converted to type imports/);
		}
		else {
			assert.doesNotMatch(extension.logs[0], /converted to type imports/);
		}

		await extension.commands.get('import-authority.organizeImports')!();

		let result = content;

		for (const edit of extension.applied.flatMap(change => change.edits)) {
			result = result.slice(0, edit.range.start) + edit.newText + result.slice(edit.range.end);
		}

		assert.equal(result.includes("import type { Model } from 'pkg';"), enabled);
	}

	const preview = activateTestExtension(content, {
		'unusedImports.useBuiltInRemoval':  true,
		'unusedImports.useFallbackRemoval': true,
	});
	await preview.commands.get('import-authority.previewOrganizeImports')!();

	const diff = preview.providerCalls.find(call => call[0] === 'vscode.diff')!;
	assert.match(String(diff[3]), /1 converted to type imports/);
	assert.match(String(preview.previewProvider.provideTextDocumentContent(diff[2] as vscode.Uri, {} as vscode.CancellationToken)), /import type \{ Model \}/);
	assert.equal(preview.applied.length, 0);
});

test('live diagnostics debounce changes, offer targeted fixes, and clear on close or disable', async () => {
	const settings  = {} as Record<string, unknown>;
	const extension = activateTestExtension("import { Z, A } from 'pkg';\n", settings);
	const doc       = extension.document as unknown as vscode.TextDocument;
	extension.documents.push(doc);
	try {
		extension.events.get('open')!(doc);
		assert.equal(extension.diagnostics.size, 0);
		await new Promise(resolve => setTimeout(resolve, 350));
		assert.equal(extension.diagnostics.get(doc.uri.toString())?.[0].code, 'organize-imports');

		const actions = extension.provider.provideCodeActions!(doc, {
			start: 0,
			end:   30
		} as unknown as vscode.Range,
			{
				only:        new Kind('quickfix'),
				diagnostics: []
			} as unknown as vscode.CodeActionContext, {} as vscode.CancellationToken) as vscode.CodeAction[];
		assert.equal(actions.length, 1);
		assert.equal(actions[0].kind?.value, 'quickfix');
		await extension.commands.get(actions[0].command!.command)!(...actions[0].command!.arguments!);
		assert.equal(extension.applied.length, 1);
		assert.equal(extension.providerCalls.length, 0);
		extension.document.version += 1;
		extension.events.get('change')!({
			document: doc
		});
		assert.equal(extension.diagnostics.size, 0);
		await extension.commands.get(actions[0].command!.command)!(...actions[0].command!.arguments!);
		assert.equal(extension.applied.length, 1);
		settings['features.enableDiagnostics'] = false;
		extension.events.get('config')!({
			affectsConfiguration: () => true
		});
		await new Promise(resolve => setTimeout(resolve, 350));
		assert.equal(extension.diagnostics.size, 0);
		settings['features.enableDiagnostics'] = true;
		extension.events.get('config')!({
			affectsConfiguration: () => true
		});
		extension.events.get('close')!(doc);
		await new Promise(resolve => setTimeout(resolve, 350));
		assert.equal(extension.diagnostics.size, 0);
	} finally {
		extension.dispose();
	}
});

test('quick fixes reject an older configuration snapshot even when the document version matches', async () => {
	const extension = activateTestExtension("import { Z, A } from 'pkg';\n");
	const doc       = extension.document as unknown as vscode.TextDocument;
	extension.documents.push(doc);

	const actions = () => extension.provider.provideCodeActions!(doc, {
		start: 0,
		end:   30
	} as unknown as vscode.Range,
		{
			only:        new Kind('quickfix'),
			diagnostics: []
		} as unknown as vscode.CodeActionContext, {} as vscode.CancellationToken) as vscode.CodeAction[];
	try {
		const old = actions()[0].command!;
		extension.events.get('config')!({
			affectsConfiguration: () => true
		});
		actions();
		await extension.commands.get(old.command)!(...old.arguments!);
		assert.equal(extension.applied.length, 0);
		assert.match(extension.messages[0], /Request the quick fix again/);
	} finally {
		extension.dispose();
	}
});

test('namespace refactors resolve open dependencies, apply exact edits and reject stale requests', async () => {
	const content   = "import * as utils from './utils.js';\nconst n = utils.answer;\nutils.format(n);\n";
	const extension = activateTestExtension(content, {
		'features.enableDiagnostics': false
	});
	const doc      = extension.document as unknown as vscode.TextDocument;
	let dependency = 'export const answer = 42; export function format(n: number) { return String(n); }';
	const dependencyDoc = {
		uri:     {
			scheme: 'file',
			fsPath: '/utils.ts'
		},
		getText: () => dependency,
	} as unknown as vscode.TextDocument;
	extension.documents.push(doc, dependencyDoc);

	const actions = () => extension.provider.provideCodeActions!(doc, {
		start: 0,
		end:   40
	} as unknown as vscode.Range,
		{
			only:        new Kind('refactor.rewrite'),
			diagnostics: []
		} as unknown as vscode.CodeActionContext, {} as vscode.CancellationToken) as vscode.CodeAction[];
	try {
		const refactor = actions()[0];
		assert.ok(refactor, 'Offers an explicit namespace refactor with diagnostics disabled');
		assert.equal(refactor.kind?.value, 'refactor.rewrite.importAuthority.namespace');
		assert.equal(extension.applied.length, 0);
		assert.equal(extension.providerCalls.length, 0);
		await extension.commands.get(refactor.command!.command)!(...refactor.command!.arguments!);

		let converted = content;

		for (const edit of [...extension.applied[0].edits].sort((a, b) => b.range.start - a.range.start)) {
			converted = converted.slice(0, edit.range.start) + edit.newText + converted.slice(edit.range.end);
		}

		assert.match(converted, /import \{ answer, format \}/);
		assert.match(converted, /format\(n\)/);
		dependency = 'export const answer = 42; export function format() { return this.answer; }';
		await extension.commands.get(refactor.command!.command)!(...refactor.command!.arguments!);
		assert.equal(extension.applied.length, 1, 'Rechecks changed dependency implementations');
		extension.document.version += 1;
		await extension.commands.get(refactor.command!.command)!(...refactor.command!.arguments!);
		assert.equal(extension.applied.length, 1);
		assert.match(extension.messages.at(-1)!, /document changed/);
	} finally {
		extension.dispose();
	}
});

test('namespace command explains rejected conversions and supports choosing between imports', async () => {
	const content   = "import * as a from './utils.js';\nimport * as b from './utils.js';\nconsole.log(a.answer, b.answer);";
	const extension = activateTestExtension(content);
	const doc       = extension.document as unknown as vscode.TextDocument;
	extension.documents.push(doc, {
		uri:     {
			scheme: 'file',
			fsPath: '/utils.ts'
		},
		getText: () => 'export const answer = 42;',
	} as unknown as vscode.TextDocument);
	await extension.commands.get('import-authority.convertNamespaceImport')!();
	assert.equal(extension.applied.length, 1);
	assert.equal(extension.applied[0].edits.length, 2, 'Converts only the chosen namespace');

	const rejected = activateTestExtension("import * as utils from './utils.js';\nconsole.log(utils);\n");
	await rejected.commands.get('import-authority.convertNamespaceImport')!();
	assert.equal(rejected.applied.length, 0);
	assert.match(rejected.messages[0], /used as an object/);
	extension.dispose();
	rejected.dispose();
});
