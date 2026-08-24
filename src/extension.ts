import ts from 'typescript';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { statSync, existsSync } from 'node:fs';
import { organizeImportsContent, removeUnusedImportsByScan } from './lib/organizer';
import { createMinimalOffsetEdit } from './lib/text-edit';
import type {
	QuoteStyle,
	SemicolonPolicy,
	TypeImportStyle,
	OrganizerOptions,
	SideEffectPlacement,
	ModuleSpecifierOrder,
	DuplicateImportPolicy
} from './lib/organizer';

type AliasPrefixCacheEntry = {
	mtimeMs: number;
	prefixes: string[];
};

type ExtensionOptions = {
	organizer: OrganizerOptions;
	removeUnusedImportsFirst: boolean;
	fallbackRemoveUnusedImportsByScan: boolean;
};

const COMMAND_ORGANIZE = 'import-authority.organizeImports';
const COMMAND_PREVIEW  = 'import-authority.previewOrganizeImports';
const PREVIEW_SCHEME   = 'import-authority-preview';
const CONFIG_NAMESPACE = 'importAuthority';

const SUPPORTED_LANGUAGE_IDS = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'vue']);
const SUPPORTED_EXTENSIONS   = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.vue']);

const DOCUMENT_SELECTOR: vscode.DocumentSelector = [
	{ language: 'typescript',      scheme: 'file' },
	{ language: 'typescriptreact', scheme: 'file' },
	{ language: 'javascript',      scheme: 'file' },
	{ language: 'javascriptreact', scheme: 'file' },
	{ language: 'typescript',      scheme: 'untitled' },
	{ language: 'typescriptreact', scheme: 'untitled' },
	{ language: 'javascript',      scheme: 'untitled' },
	{ language: 'javascriptreact', scheme: 'untitled' },
	{ language: 'vue',             scheme: 'file' },
	{ language: 'vue',             scheme: 'untitled' },
];

const aliasPrefixCache = new Map<string, AliasPrefixCacheEntry>();
const configPathCache = new Map<string, string | null>();

class PreviewContentProvider implements vscode.TextDocumentContentProvider {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
	private readonly previews = new Map<string, string>();

	public readonly onDidChange = this.onDidChangeEmitter.event;

	public set(uri: vscode.Uri, content: string): void {
		this.previews.set(uri.toString(), content);
		this.onDidChangeEmitter.fire(uri);
	}

	public provideTextDocumentContent(uri: vscode.Uri): string {
		return this.previews.get(uri.toString()) ?? '';
	}

	public delete(uri: vscode.Uri): void {
		this.previews.delete(uri.toString());
	}

	public dispose(): void {
		this.onDidChangeEmitter.dispose();
		this.previews.clear();
	}
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
	if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
		return false;
	}

	if (SUPPORTED_LANGUAGE_IDS.has(document.languageId)) {
		return true;
	}

	const extension = path.extname(document.uri.fsPath).toLowerCase();

	return SUPPORTED_EXTENSIONS.has(extension);
}

function getVirtualFilePath(document: vscode.TextDocument): string {
	if (document.uri.scheme === 'file') {
		return document.uri.fsPath;
	}

	switch (document.languageId) {
		case 'vue':
			return 'untitled.vue';
		case 'javascript':
			return 'untitled.js';
		case 'javascriptreact':
			return 'untitled.jsx';
		case 'typescriptreact':
			return 'untitled.tsx';
		default:
			return 'untitled.ts';
	}
}

function normalizeAliasPrefix(prefix: string): string {
	const trimmed = prefix.trim().replace(/\\/g, '/');
	return trimmed.replace(/\/\*$/, '').replace(/\/$/, '');
}

function dedupe(items: string[]): string[] {
	return Array.from(new Set(items.filter(Boolean)));
}

function findNearestTsConfig(startPath: string): string | null {
	const startDirectory = path.dirname(startPath);
	const cached = configPathCache.get(startDirectory);
	if (cached !== undefined) {
		return cached;
	}

	let current = startDirectory;
	while (true) {
		const tsconfig = path.join(current, 'tsconfig.json');
		if (existsSync(tsconfig)) {
			configPathCache.set(startDirectory, tsconfig);
			return tsconfig;
		}

		const jsconfig = path.join(current, 'jsconfig.json');
		if (existsSync(jsconfig)) {
			configPathCache.set(startDirectory, jsconfig);
			return jsconfig;
		}

		const parent = path.dirname(current);
		if (parent === current) {
			configPathCache.set(startDirectory, null);
			return null;
		}

		current = parent;
	}
}

function readAliasPrefixesFromConfig(configPath: string): string[] {
	try {
		const mtimeMs = statSync(configPath).mtimeMs;
		const cached = aliasPrefixCache.get(configPath);
		if (cached && cached.mtimeMs === mtimeMs) {
			return cached.prefixes;
		}

		const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
			...ts.sys,
			readDirectory: () => [],
			onUnRecoverableConfigFileDiagnostic: () => undefined,
		});
		if (!parsed) {
			aliasPrefixCache.set(configPath, { mtimeMs, prefixes: [] });
			return [];
		}

		const paths = parsed.options.paths ?? {};
		const prefixes = Object.keys(paths).map(normalizeAliasPrefix).filter(Boolean);
		const deduped = dedupe(prefixes);
		aliasPrefixCache.set(configPath, { mtimeMs, prefixes: deduped });
		return deduped;
	} catch {
		aliasPrefixCache.set(configPath, { mtimeMs: -1, prefixes: [] });
		return [];
	}
}

function getDetectedAliasPrefixes(document: vscode.TextDocument): string[] {
	if (document.uri.scheme !== 'file') {
		return [];
	}

	const configPath = findNearestTsConfig(document.uri.fsPath);
	if (!configPath) {
		return [];
	}

	return readAliasPrefixesFromConfig(configPath);
}

function getOptions(document: vscode.TextDocument): ExtensionOptions {
	const config                  = vscode.workspace.getConfiguration(CONFIG_NAMESPACE, document);
	const semicolonPolicy         = config.get<SemicolonPolicy>('style.semicolonPolicy', 'preserve');
	const quoteStyle              = config.get<QuoteStyle>('style.quoteStyle', 'preserve');
	const typeImportStyle         = config.get<TypeImportStyle>('style.typeImportStyle', 'declaration');
	const detectPathAliases       = config.get<boolean>('sorting.detectPathAliases', true);
	const configuredAliasPrefixes = (config.get<string[]>('sorting.aliasPrefixes', []) ?? []).map(normalizeAliasPrefix);
	const aliasPrefixes           = dedupe([...configuredAliasPrefixes, ...(detectPathAliases ? getDetectedAliasPrefixes(document) : []) ]);

	const organizer: OrganizerOptions = {
		placeTypeImportsLast: config.get<boolean>('sorting.placeTypeImportsLast', true),
		placeDefaultAndNamespaceImportsLast: config.get<boolean>('sorting.placeDefaultAndNamespaceImportsLast', true),
		duplicateImportPolicy: config.get<DuplicateImportPolicy>('sorting.duplicateImportPolicy', 'always'),
		groupImports: config.get<boolean>('sorting.groupImports', false),
		sideEffectPlacement: config.get<SideEffectPlacement>('sorting.sideEffectPlacement', 'top'),
		moduleSpecifierOrder: config.get<ModuleSpecifierOrder>('sorting.moduleSpecifierOrder', 'none'),
		aliasPrefixes,
		semicolonPolicy,
		quoteStyle,
		typeImportStyle,
		namedImportsWrapThreshold: Math.max(0, config.get<number>('style.namedImportsWrapThreshold', 0)),
		alignFromKeyword: config.get<boolean>('style.alignFromKeyword', false),
		normalizeRelativePaths: config.get<boolean>('style.normalizeRelativePaths', false),
	};

	return {
		organizer,
		removeUnusedImportsFirst: config.get<boolean>('unusedImports.useBuiltInRemoval', false),
		fallbackRemoveUnusedImportsByScan: config.get<boolean>('unusedImports.useFallbackRemoval', false),
	};
}

function isFormattingEnabled(document: vscode.TextDocument): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE, document);

	return config.get<boolean>('features.enableFormattingProvider', false);
}

function applyTextEdits(content: string, edits: vscode.TextEdit[], document: vscode.TextDocument): string {
	if (edits.length === 0) {
		return content;
	}

	const sorted = [...edits].sort((a, b) => {
		const startA = document.offsetAt(a.range.start);
		const startB = document.offsetAt(b.range.start);

		return startB - startA;
	});

	let result = content;
	for (const edit of sorted) {
		const start = document.offsetAt(edit.range.start);
		const end   = document.offsetAt(edit.range.end);

		result = `${result.slice(0, start)}${edit.newText}${result.slice(end)}`;
	}

	return result;
}

function getOrganizeProviderEditsForDocument(
	organizeResult: vscode.WorkspaceEdit | vscode.TextEdit[],
	document: vscode.TextDocument,
): vscode.TextEdit[] {
	if (Array.isArray(organizeResult)) {
		return organizeResult;
	}

	const edits: vscode.TextEdit[] = [];
	for (const [uri, uriEdits] of organizeResult.entries()) {
		if (uri.toString() === document.uri.toString()) {
			edits.push(...uriEdits);
		}
	}
	return edits;
}

async function removeUnusedImports(
	content: string,
	document: vscode.TextDocument,
	useScanFallback: boolean,
	expectedVersion: number,
): Promise<string | undefined> {
	try {
		const organizeResult = await vscode.commands.executeCommand<vscode.WorkspaceEdit | vscode.TextEdit[]>(
			'vscode.executeDocumentOrganizeImportsProvider',
			document.uri,
		);
		if (document.version !== expectedVersion) {
			return undefined;
		}

		let result = content;

		if (organizeResult) {
			const edits = getOrganizeProviderEditsForDocument(organizeResult, document);
			if (edits.length > 0) {
				result = applyTextEdits(content, edits, document);
			}
		}

		if (result === content && useScanFallback) {
			return removeUnusedImportsByScan(content, getVirtualFilePath(document));
		}

		return result;
	} catch {
		if (document.version !== expectedVersion) {
			return undefined;
		}
		if (useScanFallback) {
			return removeUnusedImportsByScan(content, getVirtualFilePath(document));
		}

		return content;
	}
}

type OrganizedContent = { original: string; organized: string; version: number };

async function computeOrganizedContent(document: vscode.TextDocument): Promise<OrganizedContent | undefined> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const version  = document.version;
		const options  = getOptions(document);
		const original = document.getText();
		const contentAfterUnusedRemoval = options.removeUnusedImportsFirst
			? await removeUnusedImports(original, document, options.fallbackRemoveUnusedImportsByScan, version)
			: original;

		if (contentAfterUnusedRemoval === undefined || document.version !== version) {
			continue;
		}

		const organized = organizeImportsContent(
			contentAfterUnusedRemoval,
			getVirtualFilePath(document),
			options.organizer,
		);
		return { original, organized, version };
	}

	return undefined;
}

function createMinimalTextEdit(document: vscode.TextDocument, original: string, organized: string): vscode.TextEdit | undefined {
	const edit = createMinimalOffsetEdit(original, organized);
	if (!edit) {
		return undefined;
	}

	const range = new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end));
	return vscode.TextEdit.replace(range, edit.newText);
}

async function applyOrganizedContent(document: vscode.TextDocument): Promise<void> {
	if (!isSupportedDocument(document)) {
		void vscode.window.showWarningMessage('Only JavaScript and TypeScript files are supported.');
		return;
	}

	const result = await computeOrganizedContent(document);
	if (!result) {
		void vscode.window.showWarningMessage('The document changed while imports were being organized. Please try again.');
		return;
	}

	const edit = createMinimalTextEdit(document, result.original, result.organized);
	if (!edit) {
		return;
	}
	if (document.version !== result.version) {
		void vscode.window.showWarningMessage('The document changed while imports were being organized. Please try again.');
		return;
	}

	const workspaceEdit = new vscode.WorkspaceEdit();
	workspaceEdit.set(document.uri, [edit]);
	const updated = await vscode.workspace.applyEdit(workspaceEdit);

	if (!updated) {
		void vscode.window.showErrorMessage('Import Authority failed to apply edits.');
	}
}

class ImportAuthorityCodeActionProvider implements vscode.CodeActionProvider {
	public static readonly providedCodeActionKinds = [vscode.CodeActionKind.SourceOrganizeImports];

	public provideCodeActions(document: vscode.TextDocument): vscode.CodeAction[] {
		if (!isSupportedDocument(document)) {
			return [];
		}

		const action = new vscode.CodeAction('Organize Imports (Import Authority)', vscode.CodeActionKind.SourceOrganizeImports);
		action.command = {
			command: COMMAND_ORGANIZE,
			title: 'Organize Imports',
			arguments: [document.uri],
		};
		return [action];
	}
}

class ImportAuthorityFormattingProvider implements vscode.DocumentFormattingEditProvider {
	public async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
		if (!isSupportedDocument(document) || !isFormattingEnabled(document)) {
			return [];
		}

		const result = await computeOrganizedContent(document);
		if (!result || document.version !== result.version) {
			return [];
		}

		const edit = createMinimalTextEdit(document, result.original, result.organized);
		return edit ? [edit] : [];
	}

}

export function activate(context: vscode.ExtensionContext): void {
	const previewProvider    = new PreviewContentProvider();
	const formattingProvider = new ImportAuthorityFormattingProvider();
	const configWatcher = vscode.workspace.createFileSystemWatcher('**/{tsconfig*.json,jsconfig*.json}');
	const clearConfigCaches = (): void => {
		aliasPrefixCache.clear();
		configPathCache.clear();
	};

	context.subscriptions.push(
		previewProvider,
		configWatcher,
		configWatcher.onDidCreate(clearConfigCaches),
		configWatcher.onDidChange(clearConfigCaches),
		configWatcher.onDidDelete(clearConfigCaches),
		vscode.workspace.onDidCloseTextDocument(document => {
			if (document.uri.scheme === PREVIEW_SCHEME) {
				previewProvider.delete(document.uri);
			}
		}),
		vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previewProvider),
		vscode.languages.registerCodeActionsProvider(DOCUMENT_SELECTOR, new ImportAuthorityCodeActionProvider(), {
			providedCodeActionKinds: ImportAuthorityCodeActionProvider.providedCodeActionKinds,
		}),
		vscode.languages.registerDocumentFormattingEditProvider(DOCUMENT_SELECTOR, formattingProvider),
		vscode.commands.registerCommand(COMMAND_ORGANIZE, async (targetUri?: vscode.Uri) => {
			const document = targetUri
				? await vscode.workspace.openTextDocument(targetUri)
				: vscode.window.activeTextEditor?.document;
			if (!document) {
				return;
			}

			await applyOrganizedContent(document);
		}),
		vscode.commands.registerCommand(COMMAND_PREVIEW, async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				return;
			}

			if (!isSupportedDocument(editor.document)) {
				void vscode.window.showWarningMessage('Only JavaScript and TypeScript files are supported.');
				return;
			}

			const result = await computeOrganizedContent(editor.document);
			if (!result || editor.document.version !== result.version) {
				void vscode.window.showWarningMessage('The document changed while the preview was being prepared. Please try again.');
				return;
			}
			if (result.organized === result.original) {
				void vscode.window.showInformationMessage('Imports are already organized.');
				return;
			}

			const timestamp = Date.now().toString(36);
			const baseName = path.basename(editor.document.fileName || 'untitled');
			const previewUri = vscode.Uri.from({
				scheme: PREVIEW_SCHEME,
				path: `/${baseName}.${timestamp}`,
			});

			previewProvider.set(previewUri, result.organized);

			await vscode.commands.executeCommand(
				'vscode.diff',
				editor.document.uri,
				previewUri,
				`Import Authority Preview: ${baseName}`,
			);
		}),
	);
}

export function deactivate(): void {}
