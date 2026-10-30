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
	assert.equal(await saved.save(), true);
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
	fs.writeFileSync(process.env.IMPORT_AUTHORITY_HOST_RESULTS, JSON.stringify(results, null, 2));
};
