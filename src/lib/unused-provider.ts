import type * as vscode from 'vscode';

type ExecuteCodeActionProvider = (
	command: string, uri: vscode.Uri, range: vscode.Range, kind: string, resolveCount: number,
) => Thenable<readonly (vscode.CodeAction | vscode.Command)[] | undefined>;

export async function requestUnusedImportEdits(
	document: vscode.TextDocument,
	range: vscode.Range,
	execute: ExecuteCodeActionProvider,
): Promise<vscode.TextEdit[]> {
	const version = document.version;
	// Prefer removal-only actions. Vue and other providers may only expose organize.
	for (const kind of ['source.removeUnusedImports', 'source.organizeImports']) {
		const actions = await execute('vscode.executeCodeActionProvider', document.uri, range, kind, 100);
		if (document.version !== version) { return []; }
		for (const action of actions ?? []) {
			if (!('edit' in action) || !action.edit || action.disabled
				|| action.command?.command === 'import-authority.organizeImports'
				|| !(action.kind?.value === kind || action.kind?.value.startsWith(`${kind}.`))) {
				continue;
			}
			const edits = action.edit.get(document.uri);
			// Actions are alternatives; never concatenate edits from competing providers.
			// Read their resolved edits only so preview never executes mutating commands.
			if (edits.length > 0) { return edits; }
		}
	}
	return [];
}
