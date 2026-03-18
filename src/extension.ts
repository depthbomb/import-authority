import ts from 'typescript';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { statSync, existsSync, readFileSync } from 'node:fs';
import { organizeImportsContent, removeUnusedImportsByScan } from './lib/organizer';
import type {
	QuoteStyle,
	SemicolonPolicy,
	TypeImportStyle,
	OrganizerOptions,
	SideEffectPlacement,
	ModuleSpecifierOrder,
	DuplicateImportPolicy
} from './lib/organizer';

const COMMAND_ORGANIZE = 'import-authority.organizeImports';
const COMMAND_PREVIEW  = 'import-authority.previewOrganizeImports';
const PREVIEW_SCHEME   = 'import-authority-preview';
const CONFIG_NAMESPACE = 'importAuthority';

const SUPPORTED_LANGUAGE_IDS = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);
const SUPPORTED_EXTENSIONS   = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);

const DOCUMENT_SELECTOR: vscode.DocumentSelector = [
	{ language: 'typescript',      scheme: 'file' },
	{ language: 'typescriptreact', scheme: 'file' },
	{ language: 'javascript',      scheme: 'file' },
	{ language: 'javascriptreact', scheme: 'file' },
	{ language: 'typescript',      scheme: 'untitled' },
	{ language: 'typescriptreact', scheme: 'untitled' },
	{ language: 'javascript',      scheme: 'untitled' },
	{ language: 'javascriptreact', scheme: 'untitled' },
];

type AliasPrefixCacheEntry = {
	mtimeMs: number;
	prefixes: string[];
};

const aliasPrefixCache = new Map<string, AliasPrefixCacheEntry>();

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

	public dispose(): void {
		this.onDidChangeEmitter.dispose();
		this.previews.clear();
	}
}

type ExtensionOptions = {
	organizer: OrganizerOptions;
	removeUnusedImportsFirst: boolean;
	fallbackRemoveUnusedImportsByScan: boolean;
};

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
	let current = path.dirname(startPath);
	while (true) {
		const tsconfig = path.join(current, 'tsconfig.json');
		if (existsSync(tsconfig)) {
			return tsconfig;
		}

		const jsconfig = path.join(current, 'jsconfig.json');
		if (existsSync(jsconfig)) {
			return jsconfig;
		}

		const parent = path.dirname(current);
		if (parent === current) {
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

		const text = readFileSync(configPath, 'utf8');
		const parsed = ts.parseConfigFileTextToJson(configPath, text);
		if (parsed.error || !parsed.config) {
			aliasPrefixCache.set(configPath, { mtimeMs, prefixes: [] });
			return [];
		}

		const paths = (parsed.config.compilerOptions?.paths ?? {}) as Record<string, unknown>;
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

async function removeUnusedImports(content: string, document: vscode.TextDocument, useScanFallback: boolean ): Promise<string> {
	try {
		const organizeResult = await vscode.commands.executeCommand<vscode.WorkspaceEdit | vscode.TextEdit[]>(
			'vscode.executeDocumentOrganizeImportsProvider',
			document.uri,
		);

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
		if (useScanFallback) {
			return removeUnusedImportsByScan(content, getVirtualFilePath(document));
		}

		return content;
	}
}

async function computeOrganizedContent(document: vscode.TextDocument): Promise<{ original: string; organized: string }> {
	const options  = getOptions(document);
	const original = document.getText();
	const contentAfterUnusedRemoval = options.removeUnusedImportsFirst
		? await removeUnusedImports(original, document, options.fallbackRemoveUnusedImportsByScan)
		: original;
	const organized = organizeImportsContent(
		contentAfterUnusedRemoval,
		getVirtualFilePath(document),
		options.organizer,
	);
	return { original, organized };
}

async function applyOrganizedContent(editor: vscode.TextEditor): Promise<void> {
	if (!isSupportedDocument(editor.document)) {
		void vscode.window.showWarningMessage('Only JavaScript and TypeScript files are supported.');
		return;
	}

	const { original, organized } = await computeOrganizedContent(editor.document);
	if (organized === original) {
		return;
	}

	const fullRange = new vscode.Range(
		editor.document.positionAt(0),
		editor.document.positionAt(original.length),
	);

	const updated = await editor.edit(editBuilder => {
		editBuilder.replace(fullRange, organized);
	});

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
		};
		return [action];
	}
}

class ImportAuthorityFormattingProvider implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider {
	public async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
		if (!isSupportedDocument(document) || !isFormattingEnabled(document)) {
			return [];
		}

		const { original, organized } = await computeOrganizedContent(document);
		if (organized === original) {
			return [];
		}

		const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(original.length));
		return [vscode.TextEdit.replace(fullRange, organized)];
	}

	public provideDocumentRangeFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
		return this.provideDocumentFormattingEdits(document);
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const previewProvider    = new PreviewContentProvider();
	const formattingProvider = new ImportAuthorityFormattingProvider();

	context.subscriptions.push(
		previewProvider,
		vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previewProvider),
		vscode.languages.registerCodeActionsProvider(DOCUMENT_SELECTOR, new ImportAuthorityCodeActionProvider(), {
			providedCodeActionKinds: ImportAuthorityCodeActionProvider.providedCodeActionKinds,
		}),
		vscode.languages.registerDocumentFormattingEditProvider(DOCUMENT_SELECTOR, formattingProvider),
		vscode.languages.registerDocumentRangeFormattingEditProvider(DOCUMENT_SELECTOR, formattingProvider),
		vscode.commands.registerCommand(COMMAND_ORGANIZE, async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				return;
			}

			await applyOrganizedContent(editor);
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

			const { original, organized } = await computeOrganizedContent(editor.document);
			if (organized === original) {
				void vscode.window.showInformationMessage('Imports are already organized.');
				return;
			}

			const timestamp = Date.now().toString(36);
			const baseName = path.basename(editor.document.fileName || 'untitled');
			const previewUri = vscode.Uri.parse(`${PREVIEW_SCHEME}:/${baseName}.${timestamp}`);

			previewProvider.set(previewUri, organized);

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
