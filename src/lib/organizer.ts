import { builtinModules } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export type SemicolonPolicy = 'always' | 'never' | 'preserve';
export type QuoteStyle = 'single' | 'double' | 'preserve';
export type SideEffectPlacement = 'top' | 'bottom';
export type ModuleSpecifierOrder = 'none' | 'length' | 'alpha';
export type DuplicateImportPolicy = 'always' | 'namedOnly' | 'never';
export type TypeImportStyle = 'declaration' | 'inline';

export type OrganizerOptions = {
	placeTypeImportsLast: boolean;
	placeDefaultAndNamespaceImportsLast: boolean;
	duplicateImportPolicy: DuplicateImportPolicy;
	semicolonPolicy: SemicolonPolicy;
	quoteStyle: QuoteStyle;
	typeImportStyle: TypeImportStyle;
	namedImportsWrapThreshold: number;
	groupImports: boolean;
	sideEffectPlacement: SideEffectPlacement;
	moduleSpecifierOrder: ModuleSpecifierOrder;
	aliasPrefixes: string[];
	normalizeRelativePaths: boolean;
};

export const DEFAULT_ORGANIZER_OPTIONS: OrganizerOptions = {
	placeTypeImportsLast: true,
	placeDefaultAndNamespaceImportsLast: true,
	duplicateImportPolicy: 'always',
	semicolonPolicy: 'preserve',
	quoteStyle: 'preserve',
	typeImportStyle: 'declaration',
	namedImportsWrapThreshold: 0,
	groupImports: false,
	sideEffectPlacement: 'top',
	moduleSpecifierOrder: 'none',
	aliasPrefixes: [],
	normalizeRelativePaths: false,
};

type ImportRecord = {
	moduleName: string;
	quote: '"' | "'";
	isTypeOnly: boolean;
	defaultImport?: string;
	namespaceImport?: string;
	namedImports: string[];
	leadingComments: string[];
	hadSemicolon: boolean;
	isSideEffect: boolean;
};

type ImportGroup = 'builtin' | 'external' | 'aliased' | 'relative';

type PreparedImport = {
	text: string;
	sortText: string;
	moduleName: string;
	defaultRank: number;
	typeRank: number;
	sideEffectRank: number;
	groupRank: number;
};

const BUILTIN_SET = new Set(builtinModules.flatMap(name => [name, name.replace(/^node:/, '')]));

function detectEol(content: string): string {
	return content.includes('\r\n') ? '\r\n' : '\n';
}

function getScriptKind(filePath: string): ts.ScriptKind {
	switch (path.extname(filePath).toLowerCase()) {
		case '.js':
		case '.mjs':
		case '.cjs':
			return ts.ScriptKind.JS;
		case '.jsx':
			return ts.ScriptKind.JSX;
		case '.mts':
		case '.cts':
		case '.ts':
			return ts.ScriptKind.TS;
		case '.tsx':
			return ts.ScriptKind.TSX;
		default:
			return ts.ScriptKind.TS;
	}
}

function splitNamedSpecifiers(namedImports: ts.NamedImports): { value: string[]; type: string[] } {
	const value: string[] = [];
	const type: string[] = [];

	for (const element of namedImports.elements) {
		const importName = element.propertyName
			? `${element.propertyName.text} as ${element.name.text}`
			: element.name.text;
		if (element.isTypeOnly) {
			type.push(importName);
		} else {
			value.push(importName);
		}
	}

	return { value, type };
}

function collectLeadingComments(content: string, statement: ts.ImportDeclaration): string[] {
	const ranges = ts.getLeadingCommentRanges(content, statement.getFullStart()) ?? [];
	return ranges.map(range => content.slice(range.pos, range.end).trimEnd());
}

function toImportRecords(sourceFile: ts.SourceFile, content: string): { records: ImportRecord[]; imports: ts.ImportDeclaration[] } {
	const records: ImportRecord[] = [];
	const imports = sourceFile.statements.filter(ts.isImportDeclaration);

	for (const statement of imports) {
		if (!ts.isStringLiteral(statement.moduleSpecifier)) {
			continue;
		}

		const moduleName = statement.moduleSpecifier.text;
		const moduleLiteral = statement.moduleSpecifier.getText(sourceFile);
		const quote: '"' | "'" = moduleLiteral.startsWith('"') ? '"' : "'";
		const hadSemicolon = statement.getText(sourceFile).trimEnd().endsWith(';');
		const clause = statement.importClause;
		const leadingComments = collectLeadingComments(content, statement);

		if (!clause) {
			records.push({
				moduleName,
				quote,
				isTypeOnly: false,
				namedImports: [],
				leadingComments,
				hadSemicolon,
				isSideEffect: true,
			});
			continue;
		}

		const defaultImport = clause.name?.text;
		let namespaceImport: string | undefined;
		let valueNamedImports: string[] = [];
		let typeNamedImports: string[] = [];

		if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
			namespaceImport = clause.namedBindings.name.text;
		}

		if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
			const split = splitNamedSpecifiers(clause.namedBindings);
			valueNamedImports = split.value;
			typeNamedImports = split.type;
		}

		if (clause.isTypeOnly) {
			records.push({
				moduleName,
				quote,
				isTypeOnly: true,
				defaultImport,
				namespaceImport,
				namedImports: [...valueNamedImports, ...typeNamedImports],
				leadingComments,
				hadSemicolon,
				isSideEffect: false,
			});
			continue;
		}

		if (defaultImport || namespaceImport || valueNamedImports.length > 0) {
			records.push({
				moduleName,
				quote,
				isTypeOnly: false,
				defaultImport,
				namespaceImport,
				namedImports: valueNamedImports,
				leadingComments,
				hadSemicolon,
				isSideEffect: false,
			});
		}

		if (typeNamedImports.length > 0) {
			records.push({
				moduleName,
				quote,
				isTypeOnly: true,
				namedImports: typeNamedImports,
				leadingComments: [],
				hadSemicolon,
				isSideEffect: false,
			});
		}
	}

	return { records, imports };
}

function compareByLengthThenAlpha(a: string, b: string): number {
	if (a.length === b.length) {
		return a.localeCompare(b);
	}
	return a.length - b.length;
}

function compareModuleSpecifier(a: string, b: string, order: ModuleSpecifierOrder): number {
	if (order === 'none') {
		return 0;
	}
	if (order === 'length') {
		if (a.length !== b.length) {
			return a.length - b.length;
		}
		return a.localeCompare(b);
	}
	return a.localeCompare(b);
}

function comparePreparedImports(a: PreparedImport, b: PreparedImport, options: OrganizerOptions): number {
	if (a.typeRank !== b.typeRank) {
		return a.typeRank - b.typeRank;
	}
	if (a.sideEffectRank !== b.sideEffectRank) {
		return a.sideEffectRank - b.sideEffectRank;
	}
	if (a.groupRank !== b.groupRank) {
		return a.groupRank - b.groupRank;
	}
	if (a.defaultRank !== b.defaultRank) {
		return a.defaultRank - b.defaultRank;
	}
	if (a.sortText.length !== b.sortText.length) {
		return a.sortText.length - b.sortText.length;
	}
	const specifierComparison = compareModuleSpecifier(a.moduleName, b.moduleName, options.moduleSpecifierOrder);
	if (specifierComparison !== 0) {
		return specifierComparison;
	}
	return a.sortText.localeCompare(b.sortText);
}

function normalizeNamedImports(namedImports: string[]): string[] {
	return [...namedImports].sort(compareByLengthThenAlpha);
}

function normalizeRelativeModuleName(moduleName: string): string {
	if (!moduleName.startsWith('.')) {
		return moduleName;
	}

	let normalized = path.posix.normalize(moduleName.replace(/\\/g, '/'));
	if (normalized === '.') {
		normalized = './';
	}
	if (!normalized.startsWith('.') && !normalized.startsWith('/')) {
		normalized = `./${normalized}`;
	}
	if (normalized.endsWith('/index')) {
		normalized = normalized.slice(0, -('/index'.length));
		if (normalized === '') {
			normalized = '.';
		}
	}
	if (normalized === '.') {
		return './';
	}
	return normalized;
}

function formatImport(record: ImportRecord, options: OrganizerOptions, eol: string): string {
	const quote = options.quoteStyle === 'single'
		? '\''
		: options.quoteStyle === 'double'
			? '"'
			: record.quote;
	const suffix = options.semicolonPolicy === 'always'
		? ';'
		: options.semicolonPolicy === 'never'
			? ''
			: record.hadSemicolon ? ';' : '';
	const moduleName = options.normalizeRelativePaths
		? normalizeRelativeModuleName(record.moduleName)
		: record.moduleName;

	if (record.isSideEffect) {
		return `import ${quote}${moduleName}${quote}${suffix}`;
	}

	const prefixParts: string[] = [];
	if (record.defaultImport) {
		prefixParts.push(record.defaultImport);
	}
	if (record.namespaceImport) {
		prefixParts.push(`* as ${record.namespaceImport}`);
	}
	const parts: string[] = [...prefixParts];
	const shouldUseInlineTypeNamedImports = record.isTypeOnly
		&& options.typeImportStyle === 'inline'
		&& !record.defaultImport
		&& !record.namespaceImport;
	const typeKeyword = record.isTypeOnly && !shouldUseInlineTypeNamedImports ? ' type' : '';

	if (record.namedImports.length > 0) {
		const named = normalizeNamedImports(record.namedImports);
		const namedItems = shouldUseInlineTypeNamedImports
			? named.map(item => `type ${item}`)
			: named;
		const singleLineNamed = `{ ${namedItems.join(', ')} }`;
		let formattedNamed = singleLineNamed;

		if (options.namedImportsWrapThreshold > 0 && namedItems.length > 1) {
			const candidateParts = [...prefixParts, singleLineNamed];
			const candidateImport = `import${typeKeyword} ${candidateParts.join(', ')} from ${quote}${moduleName}${quote}${suffix}`;
			if (candidateImport.length > options.namedImportsWrapThreshold) {
				formattedNamed = `{${eol}\t${namedItems.join(`,${eol}\t`)}${eol}}`;
			}
		}
		parts.push(formattedNamed);
	}

	return `import${typeKeyword} ${parts.join(', ')} from ${quote}${moduleName}${quote}${suffix}`;
}

function canMergeRecord(record: ImportRecord, policy: DuplicateImportPolicy): boolean {
	if (policy === 'always') {
		return true;
	}
	if (policy === 'never') {
		return false;
	}
	return !record.defaultImport && !record.namespaceImport;
}

function mergeRecords(records: ImportRecord[], policy: DuplicateImportPolicy): ImportRecord[] {
	if (policy === 'never') {
		return [...records];
	}

	const merged = new Map<string, ImportRecord>();
	const passthrough: ImportRecord[] = [];

	for (const record of records) {
		if (!canMergeRecord(record, policy)) {
			passthrough.push(record);
			continue;
		}
		const key = [
			record.isTypeOnly ? 'type' : 'value',
			record.moduleName,
			record.defaultImport ?? '',
			record.namespaceImport ?? '',
			record.isSideEffect ? 'side-effect' : 'bound',
		].join('|');
		const existing = merged.get(key);

		if (!existing) {
			merged.set(key, {
				...record,
				namedImports: [...record.namedImports],
				leadingComments: [...record.leadingComments],
			});
			continue;
		}

		existing.namedImports.push(...record.namedImports);
		existing.hadSemicolon ||= record.hadSemicolon;
		if (record.leadingComments.length > 0) {
			existing.leadingComments.push(...record.leadingComments);
		}
	}

	for (const record of merged.values()) {
		if (record.namedImports.length > 1) {
			record.namedImports = Array.from(new Set(record.namedImports));
		}
		if (record.leadingComments.length > 1) {
			record.leadingComments = Array.from(new Set(record.leadingComments));
		}
	}

	return [...merged.values(), ...passthrough];
}

function withDefaults(options?: Partial<OrganizerOptions>): OrganizerOptions {
	return {
		...DEFAULT_ORGANIZER_OPTIONS,
		...options,
		aliasPrefixes: options?.aliasPrefixes ?? DEFAULT_ORGANIZER_OPTIONS.aliasPrefixes,
	};
}

function rebuildContent(content: string, imports: ts.ImportDeclaration[], organizedImports: string): string {
	if (imports.length === 0) {
		return content;
	}

	const eol = detectEol(content);
	const firstImportStart = imports[0].getFullStart();
	const lastImportEnd = imports[imports.length - 1].getEnd();

	const beforeImports = content.slice(0, firstImportStart);
	const afterImports = content.slice(lastImportEnd).replace(/^(?:\s*\r?\n)+/, '');
	const importBlock = organizedImports.trim();

	if (!importBlock) {
		return `${beforeImports}${afterImports}`;
	}

	if (!afterImports) {
		return `${beforeImports}${importBlock}${eol}`;
	}

	return `${beforeImports}${importBlock}${eol}${eol}${afterImports}`;
}

function isRelativeModule(moduleName: string): boolean {
	return moduleName.startsWith('./') || moduleName.startsWith('../') || moduleName === '.' || moduleName === '..';
}

function stripNodePrefix(moduleName: string): string {
	return moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName;
}

function isAliasedModule(moduleName: string, aliasPrefixes: string[]): boolean {
	for (const rawPrefix of aliasPrefixes) {
		const prefix = rawPrefix.replace(/\/$/, '');
		if (!prefix) {
			continue;
		}
		if (moduleName === prefix || moduleName.startsWith(`${prefix}/`)) {
			return true;
		}
	}
	return false;
}

function classifyGroup(moduleName: string, aliasPrefixes: string[]): ImportGroup {
	const normalized = stripNodePrefix(moduleName);
	if (BUILTIN_SET.has(normalized)) {
		return 'builtin';
	}
	if (isRelativeModule(moduleName)) {
		return 'relative';
	}
	if (isAliasedModule(moduleName, aliasPrefixes)) {
		return 'aliased';
	}
	return 'external';
}

function getGroupRank(group: ImportGroup): number {
	switch (group) {
		case 'builtin':
			return 0;
		case 'external':
			return 1;
		case 'aliased':
			return 2;
		case 'relative':
			return 3;
	}
}

function prepareImports(records: ImportRecord[], options: OrganizerOptions, eol: string): PreparedImport[] {
	const prepared: PreparedImport[] = [];

	for (const record of records) {
		const moduleName = options.normalizeRelativePaths
			? normalizeRelativeModuleName(record.moduleName)
			: record.moduleName;
		const group = classifyGroup(moduleName, options.aliasPrefixes);
		const sortText = formatImport({ ...record, moduleName }, options, eol);
		const commentPrefix = record.leadingComments.length > 0
			? `${record.leadingComments.join(eol)}${eol}`
			: '';
		prepared.push({
			text: `${commentPrefix}${sortText}`,
			sortText,
			moduleName,
			defaultRank: options.placeDefaultAndNamespaceImportsLast && (record.defaultImport || record.namespaceImport) ? 1 : 0,
			typeRank: options.placeTypeImportsLast && record.isTypeOnly ? 1 : 0,
			sideEffectRank: record.isSideEffect
				? options.sideEffectPlacement === 'top' ? 0 : 1
				: options.sideEffectPlacement === 'top' ? 1 : 0,
			groupRank: options.groupImports ? getGroupRank(group) : 0,
		});
	}

	return prepared;
}

function joinImports(prepared: PreparedImport[], eol: string, grouped: boolean): string {
	if (prepared.length === 0) {
		return '';
	}
	if (!grouped) {
		return prepared.map(entry => entry.text).join(eol);
	}

	const blocks: string[] = [];
	let currentBlock: PreparedImport[] = [];
	let lastKey = `${prepared[0].typeRank}|${prepared[0].sideEffectRank}|${prepared[0].groupRank}`;

	for (const entry of prepared) {
		const key = `${entry.typeRank}|${entry.sideEffectRank}|${entry.groupRank}`;
		if (key !== lastKey) {
			blocks.push(currentBlock.map(item => item.text).join(eol));
			currentBlock = [entry];
			lastKey = key;
			continue;
		}
		currentBlock.push(entry);
	}
	if (currentBlock.length > 0) {
		blocks.push(currentBlock.map(item => item.text).join(eol));
	}

	return blocks.join(`${eol}${eol}`);
}

function collectUsedIdentifiers(sourceFile: ts.SourceFile): Set<string> {
	const used = new Set<string>();

	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			return;
		}
		if (ts.isIdentifier(node)) {
			used.add(node.text);
		}
		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return used;
}

function formatImportSpecifier(element: ts.ImportSpecifier): string {
	const base = element.propertyName
		? `${element.propertyName.text} as ${element.name.text}`
		: element.name.text;
	return element.isTypeOnly ? `type ${base}` : base;
}

function pruneUnusedFromImport(
	statement: ts.ImportDeclaration,
	sourceFile: ts.SourceFile,
	usedIdentifiers: Set<string>,
): string | null {
	const clause = statement.importClause;
	const statementText = statement.getText(sourceFile);
	if (!clause) {
		return statementText;
	}

	const keepDefaultImport = clause.name ? usedIdentifiers.has(clause.name.text) : false;
	const namedBindings = clause.namedBindings;
	const keepNamespaceImport = !!(namedBindings && ts.isNamespaceImport(namedBindings) && usedIdentifiers.has(namedBindings.name.text));
	const keptNamedImports = namedBindings && ts.isNamedImports(namedBindings)
		? namedBindings.elements.filter(element => usedIdentifiers.has(element.name.text))
		: [];

	if (!keepDefaultImport && !keepNamespaceImport && keptNamedImports.length === 0) {
		return null;
	}

	const parts: string[] = [];
	if (keepDefaultImport && clause.name) {
		parts.push(clause.name.text);
	}
	if (keepNamespaceImport && namedBindings && ts.isNamespaceImport(namedBindings)) {
		parts.push(`* as ${namedBindings.name.text}`);
	}
	if (keptNamedImports.length > 0) {
		parts.push(`{ ${keptNamedImports.map(formatImportSpecifier).join(', ')} }`);
	}

	const typeKeyword = clause.isTypeOnly ? ' type' : '';
	const moduleLiteral = statement.moduleSpecifier.getText(sourceFile);
	const semicolonSuffix = statementText.trimEnd().endsWith(';') ? ';' : '';
	return `import${typeKeyword} ${parts.join(', ')} from ${moduleLiteral}${semicolonSuffix}`;
}

export function removeUnusedImportsByScan(content: string, filePath = 'file.ts'): string {
	const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, getScriptKind(filePath));
	const imports = sourceFile.statements.filter(ts.isImportDeclaration);
	if (imports.length === 0) {
		return content;
	}

	const usedIdentifiers = collectUsedIdentifiers(sourceFile);
	const eol = detectEol(content);
	const keptImports: string[] = [];

	for (const statement of imports) {
		const pruned = pruneUnusedFromImport(statement, sourceFile, usedIdentifiers);
		if (!pruned) {
			continue;
		}
		const leadingComments = collectLeadingComments(content, statement);
		if (leadingComments.length > 0) {
			keptImports.push(...leadingComments);
		}
		keptImports.push(pruned);
	}

	return rebuildContent(content, imports, keptImports.join(eol));
}

export function organizeImportsContent(
	content: string,
	filePath = 'file.ts',
	options?: Partial<OrganizerOptions>,
): string {
	const resolvedOptions = withDefaults(options);
	const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, getScriptKind(filePath));
	const { records, imports } = toImportRecords(sourceFile, content);

	if (imports.length === 0) {
		return content;
	}

	const baseRecords = mergeRecords(records, resolvedOptions.duplicateImportPolicy);
	const eol = detectEol(content);
	const prepared = prepareImports(baseRecords, resolvedOptions, eol);
	prepared.sort((a, b) => comparePreparedImports(a, b, resolvedOptions));

	const organizedImports = joinImports(prepared, eol, resolvedOptions.groupImports);
	return rebuildContent(content, imports, organizedImports);
}

export function organizeImports(filePath: string, options?: Partial<OrganizerOptions>): void {
	const content = readFileSync(filePath, 'utf8');
	const organized = organizeImportsContent(content, filePath, options);

	if (organized !== content) {
		writeFileSync(filePath, organized, 'utf8');
	}
}
