import ts from 'typescript';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { convertTypeOnlyImports } from './type-imports';
import { planNamespaceImports } from './namespace-imports';
import type { OffsetEdit } from './text-edit';
import type { NamespaceConversionResult, NamespaceConversionContext } from './namespace-imports';

export type SemicolonPolicy       = 'always' | 'never' | 'preserve';
export type QuoteStyle            = 'single' | 'double' | 'preserve';
export type SideEffectPlacement   = 'top' | 'bottom';
export type ModuleSpecifierOrder  = 'none' | 'length' | 'alpha';
export type DuplicateImportPolicy = 'always' | 'namedOnly' | 'never';
export type TypeImportStyle       = 'declaration' | 'inline';

export type OrganizerOptions = {
	convertTypeOnlyImports:              boolean;
	jsxFactory?:                         string;
	jsxFragmentFactory?:                 string;
	placeTypeImportsLast:                boolean;
	placeDefaultAndNamespaceImportsLast: boolean;
	duplicateImportPolicy:               DuplicateImportPolicy;
	semicolonPolicy:                     SemicolonPolicy;
	quoteStyle:                          QuoteStyle;
	typeImportStyle:                     TypeImportStyle;
	namedImportsWrapThreshold:           number;
	alignFromKeyword:                    boolean;
	groupImports:                        boolean;
	sideEffectPlacement:                 SideEffectPlacement;
	moduleSpecifierOrder:                ModuleSpecifierOrder;
	aliasPrefixes:                       string[];
	normalizeRelativePaths:              boolean;
};

type ImportRecord = {
	sourceOrder:             number;
	moduleName:              string;
	quote:                   '"' | "'";
	attributesText?:         string;
	isTypeOnly:              boolean;
	defaultImport?:          string;
	namespaceImport?:        string;
	namedImports:            string[];
	leadingComments:         string[];
	trailingComment?:        string;
	hadSemicolon:            boolean;
	isSideEffect:            boolean;
	preserveEvaluationOrder: boolean;
	hasNamedImportsClause:   boolean;
	rawText?:                string;
};

type ImportGroup = 'builtin' | 'external' | 'aliased' | 'relative';

type PreparedImport = {
	text:                    string;
	sortText:                string;
	moduleName:              string;
	defaultRank:             number;
	typeRank:                number;
	sideEffectRank:          number;
	groupRank:               number;
	commentPrefix:           string;
	preserveEvaluationOrder: boolean;
	sourceOrder:             number;
};

type ImportDirective = 'ignore-file' | 'ignore' | 'pin' | 'off' | 'on';

type ImportBlockEdit = { start: number; end: number; text: string };

type ParsedStartTag = {
	name:        string;
	attributes:  Map<string, string | undefined>;
	end:         number;
	selfClosing: boolean;
};

type VueScriptBlock = {
	contentStart: number;
	contentEnd:   number;
	filePath:     string;
};

export type OrganizationReason = 'syntax-error' | 'ignored-file' | 'protected-imports' | 'no-imports' | 'no-supported-scripts' | 'unsupported-scripts' | 'malformed-vue';

export type OrganizationReport = {
	converted:        number;
	conversionNotes:  string[];
	content:          string;
	merged:           number;
	moved:            number;
	protectedImports: number;
	importCount:      number;
	hasDirectives:    boolean;
	hasJsx:           boolean;
	bindings:         Set<string>;
	reasons:          OrganizationReason[];
};

export type ImportFix = {
	code:    'type-import' | 'duplicate-import' | 'organize-imports';
	start:   number;
	end:     number;
	title:   string;
	message: string;
	edits:   OffsetEdit[];
};

const BUILTIN_SET = new Set(builtinModules.flatMap(name => [name, name.replace(/^node:/, '')]));

/**
 * Large duplicate buckets use binding/shape indexes. Each heap keeps source
 * order, and obsolete entries are discarded lazily when a merged clause changes.
 */
class MergeCandidateIndex {
	private readonly heaps       = new Map<string, ImportRecord[]>();
	private readonly memberships = new Map<ImportRecord, Set<string>>();

	public constructor(records: ImportRecord[]) {
		for (const record of records) {
			this.update(record);
		}
	}

	public update(record: ImportRecord): void {
		const keys    = new Set<string>();
		const oldKeys = this.memberships.get(record);

		for (const defaultName of ['*', record.defaultImport ?? null]) {
			for (const namespaceName of ['*', record.namespaceImport ?? null]) {
				const key = JSON.stringify([defaultName, namespaceName, this.shape(record)]);
				keys.add(key);

				if (oldKeys?.has(key)) {
					continue;
				}

				const heap = this.heaps.get(key) ?? [];
				let index  = heap.length;
				heap.push(record);

				while (index > 0) {
					const parent = (index - 1) >>> 1;
					if (heap[parent].sourceOrder <= record.sourceOrder) {
						break;
					}

					heap[index] = heap[parent];
					index       = parent;
				}

				heap[index] = record;
				this.heaps.set(key, heap);
			}
		}

		this.memberships.set(record, keys);
	}

	public find(record: ImportRecord): ImportRecord | undefined {
		const defaults = record.defaultImport ? [null, record.defaultImport]
			: record.isTypeOnly && (record.hasNamedImportsClause || record.namespaceImport) ? [null] : ['*'];
		const namespaces = record.namespaceImport ? [null, record.namespaceImport] : ['*'];
		const shapes = record.isTypeOnly && record.defaultImport ? ['bare']
			: record.namespaceImport ? ['bare', 'namespace']
				: record.hasNamedImportsClause ? ['bare', 'named'] : ['bare', 'named', 'namespace'];
		let first: ImportRecord | undefined;

		for (const defaultName of defaults) {
			for (const namespaceName of namespaces) {
				for (const shape of shapes) {
					const candidate = this.first(JSON.stringify([defaultName, namespaceName, shape]));
					if (candidate && (!first || candidate.sourceOrder < first.sourceOrder)) {
						first = candidate;
					}
				}
			}
		}

		return first;
	}

	private shape(record: ImportRecord): string {
		return record.namespaceImport ? 'namespace' : record.hasNamedImportsClause ? 'named' : 'bare';
	}

	private first(key: string): ImportRecord | undefined {
		const heap = this.heaps.get(key);
		while (heap?.length && !this.memberships.get(heap[0])?.has(key)) {
			const last = heap.pop()!;

			if (heap.length === 0) {
				break;
			}

			let index = 0;
			while (index * 2 + 1 < heap.length) {
				let child = index * 2 + 1;
				if (child + 1 < heap.length && heap[child + 1].sourceOrder < heap[child].sourceOrder) {
					child += 1;
				}

				if (last.sourceOrder <= heap[child].sourceOrder) {
					break;
				}

				heap[index] = heap[child];
				index       = child;
			}

			heap[index] = last;
		}

		return heap?.[0];
	}
}

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
	const value = [] as string[];
	const type  = [] as string[];

	for (const element of namedImports.elements) {
		const importName = element.propertyName
			? `${element.propertyName.getText()} as ${element.name.text}`
			: element.name.text;

		if (element.isTypeOnly) {
			type.push(importName);
		} else {
			value.push(importName);
		}
	}

	return {
		value,
		type
	};
}

function parseImportDirective(comment: string): ImportDirective | undefined {
	return /^(?:\/\/\s*|\/\*\s*)import-authority-(ignore-file|ignore|pin|off|on)\s*(?:\*\/)?$/.exec(comment)?.[1] as ImportDirective | undefined;
}

function getImportProtection(sourceFile: ts.SourceFile) {
	const protectedImports = new Set<ts.ImportDeclaration>();
	let fileIgnored        = false;
	let hasDirectives      = false;
	let disabledDepth      = 0;
	let disabledStart      = 0;
	const disabledRanges   = [] as Array<{ start: number; end: number }>;

	for (const statement of [...sourceFile.statements, sourceFile.endOfFileToken]) {
		let pinned = false;

		for (const range of ts.getLeadingCommentRanges(sourceFile.text, statement.getFullStart()) ?? []) {
			const directive = parseImportDirective(sourceFile.text.slice(range.pos, range.end));
			if (!directive) {
				continue;
			}

			hasDirectives = true;

			if (directive === 'ignore-file') {
				fileIgnored = true;
			}

			if (directive === 'off') {
				if (disabledDepth === 0) {
					disabledStart = range.pos;
				}

				disabledDepth += 1;
			}

			if (directive === 'on' && disabledDepth > 0) {
				disabledDepth -= 1;

				if (disabledDepth === 0) {
					disabledRanges.push({
						start: disabledStart,
						end:   range.end
					});
				}
			}

			if (directive === 'ignore' || directive === 'pin') {
				pinned = true;
			}
		}

		if (ts.isImportDeclaration(statement) && (pinned || disabledDepth > 0)) {
			protectedImports.add(statement);
		}
	}

	if (disabledDepth > 0) {
		disabledRanges.push({
			start: disabledStart,
			end:   sourceFile.text.length
		});
	}

	return {
		protectedImports,
		fileIgnored,
		hasDirectives,
		disabledRanges
	};
}

function collectMovableLeadingCommentRanges(content: string, statement: ts.ImportDeclaration): ts.CommentRange[] {
	const ranges = ts.getLeadingCommentRanges(content, statement.getFullStart()) ?? [];
	if (ranges.length === 0) {
		return [];
	}

	const contiguous = [] as ts.CommentRange[];
	let nextStart    = statement.getStart();

	for (let index = ranges.length - 1; index >= 0; index--) {
		const range = ranges[index];
		const gap   = content.slice(range.end, nextStart);
		if (!/^\s*$/.test(gap) || /\r?\n[ \t]*\r?\n/.test(gap)) {
			break;
		}

		contiguous.push(range);
		nextStart = range.pos;
	}

	const attached = contiguous.reverse();

	for (let index = attached.length - 1; index >= 0; index -= 1) {
		const range = attached[index];
		if (parseImportDirective(content.slice(range.pos, range.end))) {
			return attached.slice(index + 1);
		}
	}

	if (statement === (statement.parent as ts.SourceFile).statements[0]) {
		for (let index = attached.length - 1; index >= 0; index -= 1) {
			const range = attached[index];
			if (isTypeScriptDirective(content.slice(range.pos, range.end))) {
				return attached.slice(index + 1);
			}
		}
	}

	return attached;
}

function collectLeadingComments(content: string, statement: ts.ImportDeclaration): string[] {
	return collectMovableLeadingCommentRanges(content, statement)
		.map(range => content.slice(range.pos, range.end).trimEnd());
}

function collectTrailingComment(content: string, statement: ts.ImportDeclaration): string | undefined {
	const ranges = ts.getTrailingCommentRanges(content, statement.getEnd()) ?? [];

	return ranges.length > 0
		? ranges.map(range => content.slice(range.pos, range.end)).join(' ')
		: undefined;
}

function hasParseDiagnostics(sourceFile: ts.SourceFile): boolean {
	const parsed = sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };

	return (parsed.parseDiagnostics?.length ?? 0) > 0;
}

function isTypeScriptDirective(comment: string): boolean {
	return /^\/\/\/\s*<(?:reference|amd-module|amd-dependency)\b/i.test(comment)
		|| /^\/\/\s*@ts-(?:no)?check\b/i.test(comment)
		|| /@(?:jsx(?:Frag|ImportSource|Runtime)?|license|preserve)\b/i.test(comment);
}

function hasCommentTrivia(text: string): boolean {
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);

	for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
		if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
			return true;
		}
	}

	return false;
}

function toImportRecords(
	sourceFile: ts.SourceFile,
	content: string,
	imports = sourceFile.statements.filter(ts.isImportDeclaration),
	inlineTypes = false,
): { records: ImportRecord[]; imports: ts.ImportDeclaration[] } {
	const records = [] as ImportRecord[];

	for (let sourceOrder = 0; sourceOrder < imports.length; sourceOrder += 1) {
		const statement = imports[sourceOrder];
		if (!ts.isStringLiteral(statement.moduleSpecifier)) {
			continue;
		}

		const moduleName          = statement.moduleSpecifier.text;
		const moduleLiteral       = statement.moduleSpecifier.getText(sourceFile);
		const quote               = (moduleLiteral.startsWith('"') ? '"' : "'") as '"' | "'";
		const hadSemicolon        = statement.getText(sourceFile).trimEnd().endsWith(';');
		const clause              = statement.importClause;
		const shouldPinDirectives = statement === sourceFile.statements[0];
		const leadingComments = collectLeadingComments(content, statement)
			.filter(comment => !shouldPinDirectives || !isTypeScriptDirective(comment));
		const trailingComment = collectTrailingComment(content, statement);
		const attributesText  = statement.attributes?.getText(sourceFile);
		const rawText = hasCommentTrivia(statement.getText(sourceFile))
			|| statement.importClause?.phaseModifier === ts.SyntaxKind.DeferKeyword
			? statement.getText(sourceFile)
			: undefined;

		if (!clause) {
			records.push({
				sourceOrder,
				moduleName,
				quote,
				attributesText,
				isTypeOnly:   false,
				namedImports: [],
				leadingComments,
				trailingComment,
				hadSemicolon,
				isSideEffect:            true,
				preserveEvaluationOrder: true,
				hasNamedImportsClause:   false,
				rawText,
			});
			continue;
		}

		const defaultImport = clause.name?.text;
		let namespaceImport: string | undefined;
		let valueNamedImports = [] as string[];
		let typeNamedImports  = [] as string[];

		if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
			namespaceImport = clause.namedBindings.name.text;
		}

		if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
			const split       = splitNamedSpecifiers(clause.namedBindings);
			valueNamedImports = split.value;
			typeNamedImports  = split.type;
		}

		const preservesRuntimeSideEffects = !clause.isTypeOnly
			&& !defaultImport
			&& !namespaceImport
			&& valueNamedImports.length === 0
			&& typeNamedImports.length > 0;
		if (rawText || preservesRuntimeSideEffects) {
			records.push({
				sourceOrder,
				moduleName,
				quote,
				attributesText,
				isTypeOnly: clause.isTypeOnly,
				defaultImport,
				namespaceImport,
				namedImports: [...valueNamedImports, ...typeNamedImports],
				leadingComments,
				trailingComment,
				hadSemicolon,
				isSideEffect:            false,
				preserveEvaluationOrder: preservesRuntimeSideEffects,
				hasNamedImportsClause:   !!(clause.namedBindings && ts.isNamedImports(clause.namedBindings)),
				rawText:                 rawText ?? statement.getText(sourceFile),
			});
			continue;
		}

		if (inlineTypes && !clause.isTypeOnly) {
			valueNamedImports.push(...typeNamedImports.map(name => `type ${name}`));
			typeNamedImports = [];
		}

		if (clause.isTypeOnly) {
			records.push({
				sourceOrder,
				moduleName,
				quote,
				attributesText,
				isTypeOnly: true,
				defaultImport,
				namespaceImport,
				namedImports: [...valueNamedImports, ...typeNamedImports],
				leadingComments,
				trailingComment,
				hadSemicolon,
				isSideEffect:            false,
				preserveEvaluationOrder: false,
				hasNamedImportsClause:   !!(clause.namedBindings && ts.isNamedImports(clause.namedBindings)),
				rawText,
			});
			continue;
		}

		if (defaultImport || namespaceImport || valueNamedImports.length > 0 || (clause.namedBindings && ts.isNamedImports(clause.namedBindings))) {
			records.push({
				sourceOrder,
				moduleName,
				quote,
				attributesText,
				isTypeOnly: false,
				defaultImport,
				namespaceImport,
				namedImports: valueNamedImports,
				leadingComments,
				trailingComment,
				hadSemicolon,
				isSideEffect:            false,
				preserveEvaluationOrder: !!(clause.namedBindings && ts.isNamedImports(clause.namedBindings)
					&& clause.namedBindings.elements.length === 0),
				hasNamedImportsClause:   !!(clause.namedBindings && ts.isNamedImports(clause.namedBindings)),
				rawText,
			});
		}

		if (typeNamedImports.length > 0) {
			records.push({
				sourceOrder,
				moduleName,
				quote,
				attributesText,
				isTypeOnly:      true,
				namedImports:    typeNamedImports,
				leadingComments: [],
				trailingComment: undefined,
				hadSemicolon,
				isSideEffect:            false,
				preserveEvaluationOrder: false,
				hasNamedImportsClause:   true,
				rawText,
			});
		}
	}

	return {
		records,
		imports
	};
}

function getContiguousImportBlocks(sourceFile: ts.SourceFile, protection = getImportProtection(sourceFile)): Array<ts.ImportDeclaration[]> {
	const blocks = [] as Array<ts.ImportDeclaration[]>;

	if (protection.fileIgnored) {
		return blocks;
	}

	let current = [] as ts.ImportDeclaration[];

	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement) && !protection.protectedImports.has(statement)) {
			const leading = ts.getLeadingCommentRanges(sourceFile.text, statement.getFullStart()) ?? [];
			if (current.length > 0 && leading.length > collectMovableLeadingCommentRanges(sourceFile.text, statement).length) {
				blocks.push(current);
				current = [];
			}

			current.push(statement);
			continue;
		}

		if (current.length > 0) {
			blocks.push(current);
			current = [];
		}
	}

	if (current.length > 0) {
		blocks.push(current);
	}

	return blocks;
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

	if (a.preserveEvaluationOrder && b.preserveEvaluationOrder) {
		return a.sourceOrder - b.sourceOrder;
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

	/**
	 * A repeated index suffix is ambiguous: removing one segment on every run
	 * changes the target again. Keep it intact without module-resolution evidence.
	 */
	if (normalized.endsWith('/index') && !normalized.endsWith('/index/index')) {
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

function quoteModuleName(moduleName: string, quote: '"' | "'"): string {
	let escaped = '';

	for (const character of moduleName) {
		switch (character) {
			case '\\':
				escaped += '\\\\';
				break;
			case '\n':
				escaped += '\\n';
				break;
			case '\r':
				escaped += '\\r';
				break;
			case '\u2028':
				escaped += '\\u2028';
				break;
			case '\u2029':
				escaped += '\\u2029';
				break;
			default:
				escaped += character === quote ? `\\${character}` : character;
		}
	}

	return `${quote}${escaped}${quote}`;
}

function formatImport(record: ImportRecord, options: OrganizerOptions, eol: string, includeTrailingComment = true): string {
	if (record.rawText) {
		return includeTrailingComment && record.trailingComment
			? `${record.rawText} ${record.trailingComment}`
			: record.rawText;
	}

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
	const moduleLiteral    = quoteModuleName(record.moduleName, quote);
	const attributesSuffix = record.attributesText ? ` ${record.attributesText}` : '';

	if (record.isSideEffect) {
		const base = `import ${moduleLiteral}${attributesSuffix}${suffix}`;

		return includeTrailingComment && record.trailingComment ? `${base} ${record.trailingComment}` : base;
	}

	const prefixParts = [] as string[];

	if (record.defaultImport) {
		prefixParts.push(record.defaultImport);
	}

	if (record.namespaceImport) {
		prefixParts.push(`* as ${record.namespaceImport}`);
	}

	const parts       = [...prefixParts] as string[];
	const typeKeyword = record.isTypeOnly ? ' type' : '';

	if (record.namedImports.length > 0 || record.hasNamedImportsClause) {
		const named           = normalizeNamedImports(record.namedImports);
		const namedItems      = named;
		const singleLineNamed = namedItems.length > 0 ? `{ ${namedItems.join(', ')} }` : '{}';

		let formattedNamed = singleLineNamed;

		if (options.namedImportsWrapThreshold > 0 && namedItems.length > 1) {
			const candidateParts  = [...prefixParts, singleLineNamed];
			const candidateImport = `import${typeKeyword} ${candidateParts.join(', ')} from ${moduleLiteral}${attributesSuffix}${suffix}`;
			if (candidateImport.length > options.namedImportsWrapThreshold) {
				formattedNamed = `{${eol}\t${namedItems.join(`,${eol}\t`)}${eol}}`;
			}
		}

		parts.push(formattedNamed);
	}

	const base = `import${typeKeyword} ${parts.join(', ')} from ${moduleLiteral}${attributesSuffix}${suffix}`;

	return includeTrailingComment && record.trailingComment ? `${base} ${record.trailingComment}` : base;
}

function canMergeRecord(record: ImportRecord, policy: DuplicateImportPolicy): boolean {
	if (record.rawText) {
		return false;
	}

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

	const merged = new Map<string, ImportRecord[]>();
	let indexes: Map<string, MergeCandidateIndex> | undefined;
	const passthrough = [] as ImportRecord[];

	for (const record of records) {
		if (!canMergeRecord(record, policy)) {
			passthrough.push(record);
			continue;
		}

		const key = [
			record.isTypeOnly ? 'type' : 'value',
			record.moduleName,
			record.attributesText ?? '',
			record.isSideEffect ? 'side-effect' : 'bound',
		].join('|');

		const candidates   = merged.get(key) ?? [];
		let candidateIndex = indexes?.get(key);
		if (!candidateIndex && candidates.length >= 64) {
			candidateIndex = new MergeCandidateIndex(candidates);
			indexes ??= new Map();
			indexes.set(key, candidateIndex);
		}

		const existing = candidateIndex ? candidateIndex.find(record) : candidates.find(candidate => {
			const defaultImportsAreCompatible = !candidate.defaultImport
				|| !record.defaultImport
				|| candidate.defaultImport === record.defaultImport;
			const namespaceImportsAreCompatible = !candidate.namespaceImport
				|| !record.namespaceImport
				|| candidate.namespaceImport === record.namespaceImport;
			const wouldMixNamespaceAndNamed = !!(candidate.namespaceImport || record.namespaceImport)
				&& (candidate.hasNamedImportsClause || record.hasNamedImportsClause);
			const wouldMixTypeDefaultAndBindings = record.isTypeOnly
				&& !!(candidate.defaultImport || record.defaultImport)
				&& !!(candidate.namespaceImport || record.namespaceImport
					|| candidate.hasNamedImportsClause || record.hasNamedImportsClause);

			return defaultImportsAreCompatible && namespaceImportsAreCompatible
				&& !wouldMixNamespaceAndNamed && !wouldMixTypeDefaultAndBindings;
		});
		if (!existing) {
			candidates.push({
				...record,
				namedImports:    [...record.namedImports],
				leadingComments: [...record.leadingComments],
			});
			merged.set(key, candidates);
			candidateIndex?.update(candidates[candidates.length - 1]);
			continue;
		}

		existing.defaultImport ??= record.defaultImport;
		existing.namespaceImport ??= record.namespaceImport;
		existing.namedImports.push(...record.namedImports);
		existing.hasNamedImportsClause ||= record.hasNamedImportsClause;
		candidateIndex?.update(existing);
		existing.hadSemicolon ||= record.hadSemicolon;

		if (record.trailingComment) {
			if (!existing.trailingComment) {
				existing.trailingComment = record.trailingComment;
			} else if (existing.trailingComment !== record.trailingComment) {
				existing.leadingComments.push(record.trailingComment);
			}
		}

		if (record.leadingComments.length > 0) {
			existing.leadingComments.push(...record.leadingComments);
		}
	}

	const mergedRecords = Array.from(merged.values()).flat();
	for (const record of mergedRecords) {
		if (record.namedImports.length > 1) {
			record.namedImports = Array.from(new Set(record.namedImports));
		}

		if (record.leadingComments.length > 1) {
			record.leadingComments = Array.from(new Set(record.leadingComments));
		}
	}

	return [...mergedRecords, ...passthrough];
}

function withDefaults(options?: Partial<OrganizerOptions>): OrganizerOptions {
	return {
		...DEFAULT_ORGANIZER_OPTIONS,
		...options,
		aliasPrefixes: options?.aliasPrefixes ?? DEFAULT_ORGANIZER_OPTIONS.aliasPrefixes,
	};
}

function createImportBlockEdit(
	content: string,
	imports: ts.ImportDeclaration[],
	organizedImports: string,
	eol: string,
): ImportBlockEdit {
	const firstImport = imports[0];
	const start       = collectMovableLeadingCommentRanges(content, firstImport)[0]?.pos ?? firstImport.getStart();
	const lastImport  = imports[imports.length - 1];
	const comments    = ts.getTrailingCommentRanges(content, lastImport.getEnd()) ?? [];
	let end           = comments.at(-1)?.end ?? lastImport.getEnd();

	for (let cursor = end; cursor < content.length && /\s/.test(content[cursor]); cursor += 1) {
		if (content[cursor] === '\n') {
			end = cursor + 1;
		}
	}

	const block = organizedImports.trim();

	return {
		start,
		end,
		text: block ? block + eol + (end < content.length ? eol : '') : ''
	};
}

function applyImportBlockEdits(content: string, edits: ImportBlockEdit[]): string {
	const parts = [] as string[];
	let cursor  = 0;

	for (const edit of edits) {
		parts.push(content.slice(cursor, edit.start), edit.text);
		cursor = edit.end;
	}

	parts.push(content.slice(cursor));

	return parts.join('');
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
	const prepared = [] as PreparedImport[];

	for (const record of records) {
		const moduleName = options.normalizeRelativePaths
			? normalizeRelativeModuleName(record.moduleName)
			: record.moduleName;
		const group            = classifyGroup(moduleName, options.aliasPrefixes);
		const normalizedRecord = {
			...record,
			moduleName
		};
		const sortText = formatImport(normalizedRecord, options, eol, false);
		const text     = formatImport(normalizedRecord, options, eol, true);
		const commentPrefix = record.leadingComments.length > 0
			? `${record.leadingComments.join(eol)}${eol}`
			: '';

		const isEvaluationOnly = record.isSideEffect || record.preserveEvaluationOrder;
		prepared.push({
			text,
			sortText,
			moduleName,
			defaultRank:    options.placeDefaultAndNamespaceImportsLast && (record.defaultImport || record.namespaceImport) ? 1 : 0,
			typeRank:       options.placeTypeImportsLast && record.isTypeOnly ? 1 : 0,
			sideEffectRank: isEvaluationOnly
				? options.sideEffectPlacement === 'top' ? 0 : 1
				: options.sideEffectPlacement === 'top' ? 1 : 0,
			groupRank:      options.groupImports ? getGroupRank(group) : 0,
			commentPrefix,
			preserveEvaluationOrder: isEvaluationOnly,
			sourceOrder:             record.sourceOrder,
		});
	}

	return prepared;
}

function findFromKeyword(text: string): number {
	const scanner     = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
	let depth         = 0;
	let previousKind  = ts.SyntaxKind.Unknown;
	let previousStart = -1;

	for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
		if (token === ts.SyntaxKind.StringLiteral && depth === 0) {
			return previousKind === ts.SyntaxKind.FromKeyword ? previousStart : -1;
		}

		if (token === ts.SyntaxKind.OpenBraceToken) {
			depth += 1;
		}

		if (token === ts.SyntaxKind.CloseBraceToken) {
			depth -= 1;
		}

		previousKind  = token;
		previousStart = scanner.getTokenPos();
	}

	return -1;
}

function alignFromKeyword(entries: PreparedImport[]): PreparedImport[] {
	const offsets = entries.map(entry => entry.sortText.includes('\n') ? -1 : findFromKeyword(entry.sortText));
	let maxLeft   = 0;

	for (let index = 0; index < entries.length; index += 1) {
		if (offsets[index] >= 0) {
			maxLeft = Math.max(maxLeft, entries[index].sortText.slice(0, offsets[index]).trimEnd().length);
		}
	}

	return entries.map((entry, index) => {
		const offset = offsets[index];
		if (offset < 0) {
			return entry;
		}

		const align = (text: string): string => {
			const left = text.slice(0, offset).trimEnd();

			return left + ' '.repeat(maxLeft - left.length + 1) + text.slice(offset);
		};

		return {
			...entry,
			text:     align(entry.text),
			sortText: align(entry.sortText)
		};
	});
}

function renderEntry(entry: PreparedImport): string {
	return `${entry.commentPrefix}${entry.text}`;
}

function blockKey(entry: PreparedImport): string {
	return `${entry.typeRank}|${entry.sideEffectRank}|${entry.groupRank}`;
}

function splitIntoBlocks(prepared: PreparedImport[]): Array<PreparedImport[]> {
	if (prepared.length === 0) {
		return [];
	}

	const blocks = [] as Array<PreparedImport[]>;

	let currentBlock = [prepared[0]] as PreparedImport[];
	let lastKey      = blockKey(prepared[0]);

	for (let index = 1; index < prepared.length; index += 1) {
		const entry = prepared[index];
		const key   = blockKey(entry);
		if (key !== lastKey) {
			blocks.push(currentBlock);
			currentBlock = [entry];
			lastKey      = key;
			continue;
		}

		currentBlock.push(entry);
	}

	blocks.push(currentBlock);

	return blocks;
}

function applyAlignmentAndResort(prepared: PreparedImport[], options: OrganizerOptions): PreparedImport[] {
	if (!options.alignFromKeyword) {
		return prepared;
	}

	if (!options.groupImports) {
		const aligned = alignFromKeyword(prepared);
		aligned.sort((a, b) => comparePreparedImports(a, b, options));

		return aligned;
	}

	const blocks = splitIntoBlocks(prepared);
	const result = [] as PreparedImport[];

	for (const block of blocks) {
		const alignedBlock = alignFromKeyword(block);
		alignedBlock.sort((a, b) => comparePreparedImports(a, b, options));
		result.push(...alignedBlock);
	}

	return result;
}

function joinImports(prepared: PreparedImport[], eol: string, grouped: boolean): string {
	if (prepared.length === 0) {
		return '';
	}

	if (!grouped) {
		return prepared.map(renderEntry).join(eol);
	}

	const blocks = splitIntoBlocks(prepared).map(block => block.map(renderEntry).join(eol));

	return blocks.join(`${eol}${eol}`);
}

function collectUsedIdentifiers(sourceFile: ts.SourceFile, content: string): Set<string> {
	const used = new Set<string>();
	const isReference = (node: ts.Identifier): boolean => {
		const parent = node.parent;
		if (
			(ts.isPropertyAccessExpression(parent) && parent.name === node)
			|| (ts.isQualifiedName(parent) && parent.right === node)
			|| (ts.isPropertyAssignment(parent) && parent.name === node)
			|| (ts.isMethodDeclaration(parent) && parent.name === node)
			|| (ts.isPropertyDeclaration(parent) && parent.name === node)
			|| (ts.isPropertySignature(parent) && parent.name === node)
			|| (ts.isMethodSignature(parent) && parent.name === node)
			|| (ts.isGetAccessorDeclaration(parent) && parent.name === node)
			|| (ts.isSetAccessorDeclaration(parent) && parent.name === node)
			|| (ts.isEnumMember(parent) && parent.name === node)
			|| (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node))
			|| (ts.isLabeledStatement(parent) && parent.label === node)
			|| (ts.isBreakOrContinueStatement(parent) && parent.label === node)
			|| (ts.isJsxAttribute(parent) && parent.name === node)
		) {
			return false;
		}

		if (
			(ts.isVariableDeclaration(parent)
				|| ts.isParameter(parent)
				|| ts.isFunctionDeclaration(parent)
				|| ts.isFunctionExpression(parent)
				|| ts.isClassDeclaration(parent)
				|| ts.isClassExpression(parent)
				|| ts.isInterfaceDeclaration(parent)
				|| ts.isTypeAliasDeclaration(parent)
				|| ts.isEnumDeclaration(parent)
				|| ts.isModuleDeclaration(parent)
				|| ts.isTypeParameterDeclaration(parent))
			&& parent.name === node
		) {
			return false;
		}

		return true;
	};

	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			return;
		}

		if (ts.isIdentifier(node) && isReference(node)) {
			used.add(node.text);
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);

	const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, content);

	for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
		if (token !== ts.SyntaxKind.MultiLineCommentTrivia) {
			continue;
		}

		const comment = scanner.getTokenText();
		if (!comment.startsWith('/**')) {
			continue;
		}

		for (const match of comment.matchAll(/[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*/gu)) {
			used.add(match[0]);
		}
	}

	return used;
}

function formatImportSpecifier(element: ts.ImportSpecifier, sourceFile: ts.SourceFile): string {
	const base = element.propertyName
		? `${element.propertyName.getText(sourceFile)} as ${element.name.text}`
		: element.name.text;

	return element.isTypeOnly ? `type ${base}` : base;
}

function pruneUnusedFromImport(
	statement: ts.ImportDeclaration,
	sourceFile: ts.SourceFile,
	usedIdentifiers: Set<string>,
): string | null {
	const clause        = statement.importClause;
	const statementText = statement.getText(sourceFile);

	if (!clause) {
		return statementText;
	}

	if (hasCommentTrivia(statementText) || clause.phaseModifier === ts.SyntaxKind.DeferKeyword) {
		return statementText;
	}

	const keepDefaultImport   = clause.name ? usedIdentifiers.has(clause.name.text) : false;
	const namedBindings       = clause.namedBindings;
	const keepNamespaceImport = !!(namedBindings && ts.isNamespaceImport(namedBindings) && usedIdentifiers.has(namedBindings.name.text));
	const keptNamedImports = namedBindings && ts.isNamedImports(namedBindings)
		? namedBindings.elements.filter(element => usedIdentifiers.has(element.name.text))
		: [];
	const isInlineTypeOnlyRuntimeImport = !clause.isTypeOnly
		&& !clause.name
		&& !!(namedBindings && ts.isNamedImports(namedBindings))
		&& namedBindings.elements.length > 0
		&& namedBindings.elements.every(element => element.isTypeOnly);
	if (isInlineTypeOnlyRuntimeImport) {
		return statementText;
	}

	const isEmptyValueImport = !!(namedBindings && ts.isNamedImports(namedBindings)
		&& namedBindings.elements.length === 0 && !clause.isTypeOnly);
	if (!keepDefaultImport && !keepNamespaceImport && keptNamedImports.length === 0 && !isEmptyValueImport) {
		return null;
	}

	const parts = [] as string[];

	if (keepDefaultImport && clause.name) {
		parts.push(clause.name.text);
	}

	if (keepNamespaceImport && namedBindings && ts.isNamespaceImport(namedBindings)) {
		parts.push(`* as ${namedBindings.name.text}`);
	}

	if (keptNamedImports.length > 0) {
		parts.push(`{ ${keptNamedImports.map(element => formatImportSpecifier(element, sourceFile)).join(', ')} }`);
	} else if (isEmptyValueImport) {
		parts.push('{}');
	}

	const typeKeyword      = clause.isTypeOnly ? ' type' : '';
	const moduleLiteral    = statement.moduleSpecifier.getText(sourceFile);
	const attributesSuffix = statement.attributes ? ` ${statement.attributes.getText(sourceFile)}` : '';
	const semicolonSuffix  = statementText.trimEnd().endsWith(';') ? ';' : '';

	return `import${typeKeyword} ${parts.join(', ')} from ${moduleLiteral}${attributesSuffix}${semicolonSuffix}`;
}

function parseAttributes(text: string): Map<string, string | undefined> {
	const attributes = new Map<string, string | undefined>();
	let index        = 0;
	while (index < text.length) {
		while (/\s/.test(text[index] ?? '')) {
			index += 1;
		}

		if (index >= text.length || text[index] === '/') {
			break;
		}

		const nameStart = index;

		while (index < text.length && !/[\s=/>]/.test(text[index])) {
			index += 1;
		}

		const name = text.slice(nameStart, index).toLowerCase();

		while (/\s/.test(text[index] ?? '')) {
			index += 1;
		}

		let value: string | undefined;

		if (text[index] === '=') {
			index += 1;

			while (/\s/.test(text[index] ?? '')) {
				index += 1;
			}

			const quote = text[index];
			if (quote === '"' || quote === "'") {
				index += 1;

				const valueStart = index;

				while (index < text.length && text[index] !== quote) {
					index += 1;
				}

				value = text.slice(valueStart, index);

				if (text[index] === quote) {
					index += 1;
				}
			} else {
				const valueStart = index;

				while (index < text.length && !/[\s>]/.test(text[index])) {
					index += 1;
				}

				value = text.slice(valueStart, index);
			}
		}

		if (name) {
			attributes.set(name, value);
		}
	}

	return attributes;
}

function parseStartTag(content: string, offset: number): ParsedStartTag | undefined {
	if (content[offset] !== '<' || /[!/?]/.test(content[offset + 1] ?? '')) {
		return undefined;
	}

	const nameMatch = /^[A-Za-z][\w:-]*/.exec(content.slice(offset + 1));
	if (!nameMatch) {
		return undefined;
	}

	const nameEnd = offset + 1 + nameMatch[0].length;
	let index     = nameEnd;
	let quote: string | undefined;

	while (index < content.length) {
		const character = content[index];

		if (quote) {
			if (character === quote) {
				quote = undefined;
			}
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === '>') {
			const attributesText = content.slice(nameEnd, index);

			return {
				name:        nameMatch[0].toLowerCase(),
				attributes:  parseAttributes(attributesText),
				end:         index + 1,
				selfClosing: /\/\s*$/.test(attributesText),
			};
		}

		index += 1;
	}

	return undefined;
}

function findElementClose(
	content: string,
	tagName: string,
	contentStart: number,
	rawText: boolean,
): { contentEnd: number; end: number } | undefined {
	let depth  = 1;
	let cursor = contentStart;
	while (cursor < content.length) {
		const tagStart = content.indexOf('<', cursor);
		if (tagStart === -1) {
			return undefined;
		}

		if (content.startsWith('<!--', tagStart)) {
			const commentEnd = content.indexOf('-->', tagStart + 4);
			if (commentEnd === -1) {
				return undefined;
			}

			cursor = commentEnd + 3;
			continue;
		}

		const closingMatch = /^<\/\s*([A-Za-z][\w:-]*)\s*>/.exec(content.slice(tagStart));
		if (closingMatch) {
			if (closingMatch[1].toLowerCase() === tagName) {
				depth -= 1;

				if (depth === 0) {
					return {
						contentEnd: tagStart,
						end:        tagStart + closingMatch[0].length
					};
				}
			}

			cursor = tagStart + closingMatch[0].length;
			continue;
		}

		if (!rawText) {
			const opening = parseStartTag(content, tagStart);
			if (opening) {
				if (!opening.selfClosing && opening.name === tagName) {
					depth += 1;
				} else if (!opening.selfClosing && (opening.name === 'script' || opening.name === 'style')) {
					const nestedClose = findElementClose(content, opening.name, opening.end, true);
					if (!nestedClose) {
						return undefined;
					}

					cursor = nestedClose.end;
					continue;
				}

				cursor = opening.end;
				continue;
			}
		}

		cursor = tagStart + 1;
	}

	return undefined;
}

function findVueScriptBlocks(content: string, filePath: string, onUnsupported?: () => void): VueScriptBlock[] | undefined {
	const blocks = [] as VueScriptBlock[];
	let cursor   = 0;
	while (cursor < content.length) {
		const tagStart = content.indexOf('<', cursor);
		if (tagStart === -1) {
			break;
		}

		if (content.startsWith('<!--', tagStart)) {
			const commentEnd = content.indexOf('-->', tagStart + 4);
			if (commentEnd === -1) {
				return undefined;
			}

			cursor = commentEnd + 3;
			continue;
		}

		const opening = parseStartTag(content, tagStart);
		if (!opening) {
			cursor = tagStart + 1;
			continue;
		}

		if (opening.selfClosing) {
			if (opening.name === 'script') {
				onUnsupported?.();
			}

			cursor = opening.end;
			continue;
		}

		const close = findElementClose(
			content,
			opening.name,
			opening.end,
			opening.name === 'script' || opening.name === 'style',
		);
		if (!close) {
			return undefined;
		}

		if (opening.name === 'script') {
			const language = (opening.attributes.get('lang') ?? 'js').toLowerCase();
			if (!opening.attributes.has('src') && (language === 'js' || language === 'jsx' || language === 'ts' || language === 'tsx')) {
				blocks.push({
					contentStart: opening.end,
					contentEnd:   close.contentEnd,
					filePath:     `${filePath}.${language}`,
				});
			} else {
				onUnsupported?.();
			}
		}

		cursor = close.end;
	}

	return blocks;
}

function prepareImportBlock(source: ts.SourceFile, content: string, block: ts.ImportDeclaration[], options: OrganizerOptions, eol: string, report?: OrganizationReport) {
	const { records }   = toImportRecords(source, content, block, options.typeImportStyle === 'inline');
	const baseRecords   = mergeRecords(records, options.duplicateImportPolicy);
	let prepared        = prepareImports(baseRecords, options, eol);
	const originalOrder = report ? [...prepared].sort((a, b) => a.sourceOrder - b.sourceOrder).map(entry => entry.sourceOrder) : [];
	prepared.sort((a, b) => comparePreparedImports(a, b, options));
	prepared = applyAlignmentAndResort(prepared, options);

	const merged = records.length - baseRecords.length;

	if (report) {
		report.merged += merged;
		report.moved += prepared.filter((entry, index) => entry.sourceOrder !== originalOrder[index]).length;
	}

	return {
		prepared,
		merged
	};
}

function organizeScriptContent(content: string, filePath: string, options?: Partial<OrganizerOptions>, report?: OrganizationReport, scope = ''): string {
	const resolvedOptions = withDefaults(options);
	let sourceFile        = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, getScriptKind(filePath));
	let protection        = getImportProtection(sourceFile);
	if (resolvedOptions.convertTypeOnlyImports && !protection.fileIgnored && !hasParseDiagnostics(sourceFile)) {
		const conversion = convertTypeOnlyImports(sourceFile, getContiguousImportBlocks(sourceFile, protection).flat(), resolvedOptions, resolvedOptions.typeImportStyle === 'inline');

		if (report) {
			report.converted += conversion.converted;

			if (conversion.note) {
				report.conversionNotes.push(conversion.note);
			}
		}

		if (conversion.content !== content) {
			content    = conversion.content;
			sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, getScriptKind(filePath));
			protection = getImportProtection(sourceFile);
		}
	}

	if (report) {
		report.hasDirectives ||= protection.hasDirectives;

		const visit = (node: ts.Node): boolean => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)
			|| ts.isJsxFragment(node) || !!ts.forEachChild(node, visit);
		report.hasJsx ||= visit(sourceFile);

		for (const statement of sourceFile.statements.filter(ts.isImportDeclaration)) {
			report.importCount += 1;

			const clause = statement.importClause;
			const names  = clause?.namedBindings;
			const namedBindings = names ? ts.isNamespaceImport(names)
				? [names.name.text] : names.elements.map(element => element.name.text) : [];
			const bindings = [clause?.name?.text, ...namedBindings];
			const moduleName = ts.isStringLiteral(statement.moduleSpecifier)
				? statement.moduleSpecifier.text : statement.moduleSpecifier.getText(sourceFile);

			for (const binding of bindings) {
				if (binding) {
					report.bindings.add(JSON.stringify([scope, moduleName, binding]));
				}
			}
		}

		report.protectedImports += protection.protectedImports.size;

		if (protection.protectedImports.size > 0) {
			report.reasons.push('protected-imports');
		}
	}

	if (protection.fileIgnored) {
		report?.reasons.push('ignored-file');

		return content;
	}

	if (hasParseDiagnostics(sourceFile)) {
		report?.reasons.push('syntax-error');

		return content;
	}

	const importBlocks = getContiguousImportBlocks(sourceFile, protection);
	if (importBlocks.length === 0) {
		return content;
	}

	const eol   = detectEol(content);
	const edits = [] as ImportBlockEdit[];

	for (const block of importBlocks) {
		const { prepared } = prepareImportBlock(sourceFile, content, block, resolvedOptions, eol, report);

		const organizedImports = joinImports(prepared, eol, resolvedOptions.groupImports);
		edits.push(createImportBlockEdit(content, block, organizedImports, eol));
	}

	return applyImportBlockEdits(content, edits);
}

function organizeContent(content: string, filePath: string, options?: Partial<OrganizerOptions>, report?: OrganizationReport): string {
	if (path.extname(filePath).toLowerCase() !== '.vue') {
		return organizeScriptContent(content, filePath, options, report);
	}

	if (withDefaults(options).convertTypeOnlyImports) {
		report?.conversionNotes.push('Type-import conversion skipped for Vue because template references require the Vue language service.');
		options = {
			...options,
			convertTypeOnlyImports: false
		};
	}

	let skippedScripts = false;
	const scriptBlocks = findVueScriptBlocks(content, filePath, () => {
		skippedScripts = true;
	});
	if (!scriptBlocks) {
		report?.reasons.push('malformed-vue');

		return content;
	}

	if (scriptBlocks.length === 0) {
		report?.reasons.push('no-supported-scripts');
	}
	else if (skippedScripts) {
		report?.reasons.push('unsupported-scripts');
	}

	if (scriptBlocks.some(block => getImportProtection(ts.createSourceFile(
		block.filePath, content.slice(block.contentStart, block.contentEnd), ts.ScriptTarget.Latest, true, getScriptKind(block.filePath),
	)).fileIgnored)) {
		if (report) {
			report.hasDirectives = true;
			report.reasons.push('ignored-file');
		}

		return content;
	}

	let nextContent = content;

	for (let index = scriptBlocks.length - 1; index >= 0; index -= 1) {
		const block           = scriptBlocks[index];
		const originalScript  = content.slice(block.contentStart, block.contentEnd);
		const organizedScript = organizeScriptContent(originalScript, block.filePath, options, report, String(index));
		nextContent           = `${nextContent.slice(0, block.contentStart)}${organizedScript}${nextContent.slice(block.contentEnd)}`;
	}

	return nextContent;
}

export const DEFAULT_ORGANIZER_OPTIONS = {
	convertTypeOnlyImports:              true,
	placeTypeImportsLast:                true,
	placeDefaultAndNamespaceImportsLast: true,
	duplicateImportPolicy:               'always',
	semicolonPolicy:                     'preserve',
	quoteStyle:                          'preserve',
	typeImportStyle:                     'declaration',
	namedImportsWrapThreshold:           0,
	alignFromKeyword:                    false,
	groupImports:                        false,
	sideEffectPlacement:                 'top',
	moduleSpecifierOrder:                'none',
	aliasPrefixes:                       [],
	normalizeRelativePaths:              false,
} as OrganizerOptions;

// Providers cannot be trusted to preserve this extension's sorting boundaries.
export function hasImportAuthorityDirectives(content: string, filePath = 'file.ts'): boolean {
	if (path.extname(filePath).toLowerCase() === '.vue') {
		return (findVueScriptBlocks(content, filePath) ?? []).some(block =>
			hasImportAuthorityDirectives(content.slice(block.contentStart, block.contentEnd), block.filePath));
	}

	return getImportProtection(ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, getScriptKind(filePath))).hasDirectives;
}

export function removeUnusedImportsByScan(content: string, filePath = 'file.ts'): string {
	if (path.extname(filePath).toLowerCase() === '.vue') {
		return content;
	}

	const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, getScriptKind(filePath));
	if (hasParseDiagnostics(sourceFile)) {
		return content;
	}

	/**
	 * JSX factories and fragment bindings can be supplied by compiler or build
	 * configuration that this standalone heuristic cannot safely infer.
	 */
	const containsJsx = (node: ts.Node): boolean => ts.isJsxElement(node)
		|| ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)
		|| !!ts.forEachChild(node, containsJsx);
	if (containsJsx(sourceFile)) {
		return content;
	}

	const importBlocks = getContiguousImportBlocks(sourceFile);
	if (importBlocks.length === 0) {
		return content;
	}

	const usedIdentifiers = collectUsedIdentifiers(sourceFile, content);
	const eol             = detectEol(content);
	const edits           = [] as ImportBlockEdit[];

	for (const block of importBlocks) {
		const keptImports = [] as string[];

		for (const statement of block) {
			const shouldPinDirectives = statement === sourceFile.statements[0];
			const leadingComments = collectLeadingComments(content, statement)
				.filter(comment => !shouldPinDirectives || !isTypeScriptDirective(comment));
			const pruned = pruneUnusedFromImport(statement, sourceFile, usedIdentifiers);
			if (!pruned && leadingComments.length === 0) {
				continue;
			}

			if (leadingComments.length > 0) {
				keptImports.push(...leadingComments);
			}

			const trailingComment = collectTrailingComment(content, statement);
			const importText      = pruned ?? statement.getText(sourceFile);
			keptImports.push(trailingComment ? `${importText} ${trailingComment}` : importText);
		}

		edits.push(createImportBlockEdit(content, block, keptImports.join(eol), eol));
	}

	return applyImportBlockEdits(content, edits);
}

export function getNamespaceImportFixes(content: string, filePath = 'file.ts', context?: NamespaceConversionContext): NamespaceConversionResult {
	const skip = (reason: string): NamespaceConversionResult => ({
		fixes:   [],
		skipped: [{
			name: 'File',
			reason
		}]
	});

	if (path.extname(filePath).toLowerCase() === '.vue') {
		return skip('Vue template references require the Vue language service.');
	}

	const source     = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, getScriptKind(filePath));
	const protection = getImportProtection(source);

	if (hasParseDiagnostics(source)) {
		return skip('The file has syntax errors.');
	}

	if (protection.fileIgnored) {
		return skip('The file is ignored by Import Authority.');
	}

	const result = planNamespaceImports(source, getContiguousImportBlocks(source, protection).flat(), context);
	result.fixes = result.fixes.filter(fix => {
		if (fix.edits.some(edit => protection.disabledRanges.some(range => edit.start < range.end && edit.end > range.start))) {
			result.skipped.push({
				name:   fix.name,
				reason: 'A namespace reference is inside a disabled region.'
			});

			return false;
		}

		return true;
	});

	return result;
}

// Local, read-only analysis; deliberately never invokes external removal providers.
export function getImportFixes(content: string, filePath = 'file.ts', options?: Partial<OrganizerOptions>): ImportFix[] {
	const resolvedOptions = withDefaults(options);

	if (path.extname(filePath).toLowerCase() === '.vue') {
		const blocks = findVueScriptBlocks(content, filePath);
		if (!blocks || blocks.some(block => getImportProtection(ts.createSourceFile(
			block.filePath, content.slice(block.contentStart, block.contentEnd), ts.ScriptTarget.Latest, true, getScriptKind(block.filePath),
		)).fileIgnored)) {
			return [];
		}

		return blocks.flatMap(block => getImportFixes(content.slice(block.contentStart, block.contentEnd), block.filePath,
			{
				...options,
				convertTypeOnlyImports: false
			}).map(fix => ({
				...fix,
				start: fix.start + block.contentStart,
				end:   fix.end + block.contentStart,
				edits: fix.edits.map(edit => ({
					...edit,
					start: edit.start + block.contentStart,
					end:   edit.end + block.contentStart
				})),
			})));
	}

	const source     = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, getScriptKind(filePath));
	const protection = getImportProtection(source);
	if (protection.fileIgnored || hasParseDiagnostics(source)) {
		return [];
	}

	const blocks = getContiguousImportBlocks(source, protection);
	const fixes  = [] as ImportFix[];

	if (resolvedOptions.convertTypeOnlyImports) {
		const conversion = convertTypeOnlyImports(source, blocks.flat(), resolvedOptions, resolvedOptions.typeImportStyle === 'inline');
		for (const edit of conversion.edits) {
			fixes.push({
				code:    'type-import',
				start:   edit.start,
				end:     edit.end,
				title:   'Convert type-only bindings in this import',
				message: 'This import has bindings used only as types.',
				edits:   [edit],
			});
		}
	}

	const eol = detectEol(content);

	for (const block of blocks) {
		const { prepared, merged } = prepareImportBlock(source, content, block, resolvedOptions, eol);
		const edit                 = createImportBlockEdit(content, block, joinImports(prepared, eol, resolvedOptions.groupImports), eol);
		if (content.slice(edit.start, edit.end) === edit.text) {
			continue;
		}

		fixes.push({
			code:    merged > 0 ? 'duplicate-import' : 'organize-imports',
			start:   block[0].getStart(source),
			end:     block[block.length - 1].getEnd(),
			title:   merged > 0 ? 'Merge duplicates and organize this import block' : 'Organize this import block',
			message: merged > 0 ? 'This import block contains mergeable duplicate imports.' : 'This import block does not match your organization settings.',
			edits:   [{
				start:   edit.start,
				end:     edit.end,
				newText: edit.text
			}],
		});
	}

	return fixes;
}

export function organizeImportsContent(
	content: string,
	filePath = 'file.ts',
	options?: Partial<OrganizerOptions>,
): string {
	return organizeContent(content, filePath, options);
}

export function organizeImportsWithReport(content: string, filePath = 'file.ts', options?: Partial<OrganizerOptions>): OrganizationReport {
	const report = {
		converted:       0,
		conversionNotes: [],
		content,
		merged:           0,
		moved:            0,
		protectedImports: 0,
		importCount:      0,
		hasDirectives:    false,
		hasJsx:           false,
		bindings:         new Set(),
		reasons:          [],
	} as OrganizationReport;
	report.content = organizeContent(content, filePath, options, report);

	if (report.importCount === 0 && report.reasons.length === 0) {
		report.reasons.push('no-imports');
	}

	report.reasons         = [...new Set(report.reasons)];
	report.conversionNotes = [...new Set(report.conversionNotes)];

	return report;
}

export function organizeImports(filePath: string, options?: Partial<OrganizerOptions>): void {
	const content   = readFileSync(filePath, 'utf8');
	const organized = organizeImportsContent(content, filePath, options);
	if (organized !== content) {
		writeFileSync(filePath, organized, 'utf8');
	}
}
