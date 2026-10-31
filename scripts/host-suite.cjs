const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

async function eventually(read, description) {
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		try {
			const value = await read();
			if (value) return value;
		} catch (error) {
			if (!['Canceled', 'CancellationError'].includes(error.name)) throw error;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out: ${description}`);
}

async function replace(document, text) {
	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
	assert.equal(await vscode.workspace.applyEdit(edit), true);
}

exports.run = async () => {
	const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
	const extension = vscode.extensions.getExtension('CaprineLogic.import-authority');
	assert.ok(extension);
	await extension.activate();
	const results = { version: vscode.version };
	const source = "import { Zebra } from 'zebra';\nimport { A } from 'a';\nlet value: A;\nconsole.log(Zebra);\n";
	const open = async (name, text) => {
		const filename = path.join(workspace, name);
		fs.mkdirSync(path.dirname(filename), { recursive: true });
		fs.writeFileSync(filename, text);
		const document = await vscode.workspace.openTextDocument(filename);
		await vscode.window.showTextDocument(document);
		return document;
	};
	const diagnostics = document => vscode.languages.getDiagnostics(document.uri).filter(item => item.source === 'Import Authority');
	const range = document => new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
	const actions = (document, kind) => eventually(async () => {
		const items = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, range(document), kind, 100);
		return items?.length ? items : undefined;
	}, `actions ${kind}`);
	const save = async document => {
		// Wait for the new editor's language and source-action provider to be ready.
		await actions(document, 'source.organizeImports.importAuthority');
		const setting = vscode.workspace.getConfiguration('editor', document).get('codeActionsOnSave');
		assert.equal(setting['source.organizeImports.importAuthority'], 'explicit');
		const events = [];
		const subscriptions = [
			vscode.workspace.onWillSaveTextDocument(event => {
				if (event.document === document) events.push({ event: 'willSave', reason: event.reason, version: document.version });
			}),
			vscode.workspace.onDidChangeTextDocument(event => {
				if (event.document === document) events.push({ event: 'change', version: document.version });
			}),
			vscode.workspace.onDidSaveTextDocument(saved => {
				if (saved === document) events.push({ event: 'didSave', version: document.version });
			}),
		];
		try {
			assert.equal(await document.save(), true);
		} finally {
			console.log(JSON.stringify({ save: document.uri.toString(), language: document.languageId, dirty: document.isDirty, events }));
			subscriptions.forEach(subscription => subscription.dispose());
		}
	};

	const document = await open('command.ts', source);
	console.log('Host: diagnostics and quick fixes');
	await eventually(() => diagnostics(document).length, 'live diagnostics');
	results.diagnostics = diagnostics(document).map(item => ({ code: item.code, message: item.message, severity: item.severity, range: [document.offsetAt(item.range.start), document.offsetAt(item.range.end)] }));
	const quickFixes = (await actions(document, 'quickfix')).filter(item => item.command?.command === 'import-authority.applyImportFix');
	assert.ok(quickFixes.length, JSON.stringify(await actions(document, 'quickfix')));
	results.quickFixTitles = quickFixes.map(item => item.title);
	const stale = quickFixes[0].command;
	await replace(document, source + '// changed\n');
	await vscode.commands.executeCommand(stale.command, ...stale.arguments);
	assert.equal(document.getText(), source + '// changed\n');
	results.staleQuickFix = document.getText();
	await replace(document, source);
	await vscode.commands.executeCommand('import-authority.organizeImports', document.uri);
	assert.notEqual(document.getText(), source);
	results.command = document.getText();
	await eventually(() => diagnostics(document).length === 0, 'diagnostics clear after organization');
	await vscode.commands.executeCommand('undo');
	assert.equal(document.getText(), source);
	results.undo = document.getText();

	console.log('Host: preview, explain, formatting and save');
	await vscode.commands.executeCommand('import-authority.previewOrganizeImports');
	const preview = await eventually(() => vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'import-authority-preview'), 'preview document');
	results.preview = preview.getText();
	assert.equal(document.getText(), source);
	await vscode.window.showTextDocument(document);
	await vscode.commands.executeCommand('import-authority.explainImports');
	assert.equal(document.getText(), source);
	results.explainReadOnly = document.getText();

	const formatting = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri, { tabSize: 4, insertSpaces: false });
	assert.ok(formatting.length);
	results.formatting = formatting.map(edit => ({ start: document.offsetAt(edit.range.start), end: document.offsetAt(edit.range.end), text: edit.newText }));
	const saved = await open('save.ts', source);
	await replace(saved, source + '// save\n');
	await save(saved);
	assert.notEqual(saved.getText(), source + '// save\n');
	results.save = saved.getText();
	results.savedFile = fs.readFileSync(saved.uri.fsPath, 'utf8');

	console.log('Host: namespace refactors and open dependency edits');
	const dependency = await open('lib.ts', 'export const answer = 1;');
	await replace(dependency, 'export const answer = 2; export const call = () => answer;');
	const namespaceSource = "import * as utils from './lib';\n/** utils provide helpers */\nconsole.log(utils.answer, utils.call());\n";
	const namespace = await open('namespace.ts', namespaceSource);
	const refactors = (await actions(namespace, 'refactor.rewrite')).filter(item => item.command?.command === 'import-authority.convertNamespaceImport');
	assert.equal(refactors.length, 1);
	const refactor = refactors[0].command;
	await replace(namespace, namespaceSource + '// changed\n');
	await vscode.commands.executeCommand(refactor.command, ...refactor.arguments);
	assert.equal(namespace.getText(), namespaceSource + '// changed\n');
	results.staleRefactor = namespace.getText();
	await vscode.commands.executeCommand('import-authority.convertNamespaceImport', namespace.uri);
	assert.doesNotMatch(namespace.getText(), /import \* as/);
	results.namespace = namespace.getText();

	console.log('Host: file kinds and untitled buffers');
	for (const suffix of ['js', 'jsx', 'tsx', 'mts', 'cts', 'vue']) {
		const content = suffix === 'vue' ? `<script setup lang="ts">\n${source}</script>\n<template><A /></template>` : source;
		const file = await open(`file.${suffix}`, content);
		if (suffix === 'vue') await vscode.languages.setTextDocumentLanguage(file, 'vue');
		await vscode.commands.executeCommand('import-authority.organizeImports', file.uri);
		results[suffix] = file.getText();
	}
	const untitled = await vscode.workspace.openTextDocument({ language: 'typescript', content: source });
	await vscode.window.showTextDocument(untitled);
	await vscode.commands.executeCommand('import-authority.organizeImports');
	results.untitled = untitled.getText();
	assert.notEqual(results.untitled, source);

	console.log('Host: monorepo aliases, inherited JSX config and live config changes');
	const baseConfig = path.join(workspace, 'tsconfig.base.json');
	const config = factory => JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', baseUrl: '.', paths: { '@shared/*': ['packages/shared/src/*'] }, jsxFactory: factory, jsxFragmentFactory: 'Fragment' } });
	fs.writeFileSync(baseConfig, config('h'));
	await open('packages/shared/src/math.ts', 'export const answer = 42; export const increment = (n: number) => n + 1;');
	await open('packages/app/tsconfig.json', '{"extends":"../../tsconfig.base.json","compilerOptions":{"strict":true}}');
	const aliased = await open('packages/app/alias.ts', "import * as math from '@shared/math';\nconsole.log(math.increment(math.answer));\n");
	await vscode.commands.executeCommand('import-authority.convertNamespaceImport', aliased.uri);
	assert.doesNotMatch(aliased.getText(), /import \* as/);
	results.monorepoAlias = aliased.getText();
	const renderSource = "import { h } from 'renderer';\nimport { LongerName } from '@shared/types';\nlet factory: typeof h;\nconst view = <div />;\n";
	const render = await open('packages/app/render.tsx', renderSource);
	const formatted = async doc => {
		const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', doc.uri, { tabSize: 4, insertSpaces: false });
		let text = doc.getText();
		for (const edit of edits.sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start))) {
			text = text.slice(0, doc.offsetAt(edit.range.start)) + edit.newText + text.slice(doc.offsetAt(edit.range.end));
		}
		return text;
	};
	results.inheritedFactory = await formatted(render);
	assert.doesNotMatch(results.inheritedFactory, /import type \{ h \}/);
	fs.writeFileSync(baseConfig, config('differentFactory'));
	results.changedFactory = await eventually(async () => {
		const text = await formatted(render);
		return /import type \{ h \}/.test(text) ? text : undefined;
	}, 'changed inherited config invalidates cached options');
	fs.writeFileSync(baseConfig, config('h'));
	await eventually(async () => !/import type \{ h \}/.test(await formatted(render)), 'restored JSX factory');

	console.log('Host: repeated TSX edits, save actions and undo');
	const tsxSource = "/** @jsx React.createElement */\nimport * as React from 'react';\nimport { Button, ButtonProps } from '@shared/ui';\nexport const View = (props: ButtonProps) => <Button {...props} />;\n";
	const view = await open('packages/app/view.tsx', tsxSource);
	results.tsxSaves = [];
	for (let iteration = 0; iteration < 12; iteration++) {
		await replace(view, tsxSource + `// edit ${iteration}\n`);
		await save(view);
		assert.match(view.getText(), /import type \{ ButtonProps \}/);
		assert.match(view.getText(), /import \* as React/);
		assert.equal(fs.readFileSync(view.uri.fsPath, 'utf8'), view.getText());
		results.tsxSaves.push(view.getText());
	}

	await vscode.workspace.getConfiguration('importAuthority', view).update('features.enableDiagnostics', false, vscode.ConfigurationTarget.Workspace);
	await eventually(() => diagnostics(view).length === 0, 'diagnostics disabled after setting change');
	results.disabledDiagnostics = diagnostics(view);
	fs.writeFileSync(process.env.IMPORT_AUTHORITY_HOST_RESULTS, JSON.stringify(results, null, 2));
};
