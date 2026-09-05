import test from 'node:test';
import assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import { requestUnusedImportEdits } from './unused-provider';

const uri = { toString: () => 'file:///test.ts' } as vscode.Uri;
const range = {} as vscode.Range;
const edit = { range, newText: '' };
const action = (kind: string, edits = [edit]): vscode.CodeAction => ({
	title: 'Remove unused imports', kind: { value: kind },
	edit: { get: (target: vscode.Uri) => target === uri ? edits : [] },
}) as vscode.CodeAction;
const document = (): vscode.TextDocument => ({ uri, version: 1 }) as vscode.TextDocument;

test('requests resolved removal actions through the supported API', async () => {
	const calls: unknown[][] = [];
	const edits = await requestUnusedImportEdits(document(), range, async (...args) => {
		calls.push(args);
		return [action('source.removeUnusedImports'), action('source.removeUnusedImports', [{ range, newText: 'alternative' }])];
	});
	assert.deepEqual(calls, [['vscode.executeCodeActionProvider', uri, range, 'source.removeUnusedImports', 100]]);
	assert.deepEqual(edits, [edit]);
});

test('falls back to organize edits while ignoring self, disabled and command-only actions', async () => {
	const kinds: string[] = [];
	const edits = await requestUnusedImportEdits(document(), range, async (_command, _uri, _range, kind) => {
		kinds.push(kind);
		if (kind === 'source.removeUnusedImports') { return []; }
		return [
			{ ...action(kind), command: { command: 'import-authority.organizeImports', title: '' } },
			{ ...action(kind), disabled: { reason: 'disabled' } },
			{ title: 'Command only', command: 'mutate.document' },
			action(kind, []),
			action('source.fixAll'),
			action(kind),
		];
	});
	assert.deepEqual(kinds, ['source.removeUnusedImports', 'source.organizeImports']);
	assert.deepEqual(edits, [edit]);
});

test('discards stale provider results and propagates failure for the scan fallback', async () => {
	const doc = document();
	assert.deepEqual(await requestUnusedImportEdits(doc, range, async () => {
		Object.assign(doc, { version: 2 });
		return [action('source.removeUnusedImports')];
	}), []);
	await assert.rejects(requestUnusedImportEdits(document(), range, async () => { throw new Error('provider failed'); }));
	assert.deepEqual(await requestUnusedImportEdits(document(), range, async () => undefined), []);
});
