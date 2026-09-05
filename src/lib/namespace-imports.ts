import ts from 'typescript';
import path from 'node:path';
import type { OffsetEdit } from './text-edit';

export type NamespaceConversionContext = {
	compilerOptions?: ts.CompilerOptions;
	readFile?: (filename: string) => string | undefined;
	fileExists?: (filename: string) => boolean;
	directoryExists?: (directory: string) => boolean;
};

export type NamespaceImportFix = {
	name: string;
	moduleName: string;
	start: number;
	end: number;
	edits: OffsetEdit[];
};

export type NamespaceConversionResult = {
	fixes: NamespaceImportFix[];
	skipped: Array<{ name: string; reason: string }>;
};

function hasComments(text: string): boolean {
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
	for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
		if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) { return true; }
	}
	return false;
}

function receiverIndependent(access: ts.PropertyAccessExpression, checker: ts.TypeChecker): boolean {
	let symbol = checker.getSymbolAtLocation(access.name);
	if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) { symbol = checker.getAliasedSymbol(symbol); }
	for (const declaration of symbol?.declarations ?? []) {
		const fn = ts.isFunctionDeclaration(declaration) ? declaration
			: ts.isVariableDeclaration(declaration) && declaration.initializer
				&& (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) ? declaration.initializer : undefined;
		if (!fn?.body) { continue; }
		if (ts.isVariableDeclaration(declaration) && !(declaration.parent.flags & ts.NodeFlags.Const)) { continue; }
		if (fn.parameters.some(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === 'this')) { continue; }
		let dependent = false;
		const inspect = (node: ts.Node): void => {
			dependent ||= node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword
				|| ts.isIdentifier(node) && (node.text === 'eval' || node.text === 'arguments');
			ts.forEachChild(node, inspect);
		};
		inspect(fn);
		const inspectModule = (node: ts.Node): void => {
			if (ts.isIdentifier(node) && (node.text === 'eval' || checker.getSymbolAtLocation(node) === symbol && isWrite(node))) { dependent = true; }
			ts.forEachChild(node, inspectModule);
		};
		inspectModule(declaration.getSourceFile());
		if (!dependent) { return true; }
	}
	return false;
}

function isWrite(access: ts.Node): boolean {
	for (let node = access; node.parent && !ts.isStatement(node); node = node.parent) {
		const parent = node.parent;
		if (ts.isDeleteExpression(parent) || ts.isPostfixUnaryExpression(parent)
			|| ts.isPrefixUnaryExpression(parent) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
			|| ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
			|| (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === node) { return true; }
	}
	return false;
}

function isReceiverCall(access: ts.Node): boolean {
	let expression = access;
	while (ts.isParenthesizedExpression(expression.parent) || ts.isNonNullExpression(expression.parent)
		|| ts.isAsExpression(expression.parent) || ts.isTypeAssertionExpression(expression.parent) || ts.isSatisfiesExpression(expression.parent)) { expression = expression.parent; }
	return ts.isCallExpression(expression.parent) && expression.parent.expression === expression
		|| ts.isTaggedTemplateExpression(expression.parent) && expression.parent.tag === expression;
}

/** Plan one explicit refactor per eligible namespace, without applying any edits. */
export function planNamespaceImports(source: ts.SourceFile, imports: ts.ImportDeclaration[], context: NamespaceConversionContext = {}): NamespaceConversionResult {
	const result: NamespaceConversionResult = { fixes: [], skipped: [] };
	const candidates = imports.filter(statement => statement.importClause?.namedBindings && ts.isNamespaceImport(statement.importClause.namedBindings));
	if (candidates.length === 0) { return result; }
	const options: ts.CompilerOptions = {
		module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.Latest,
		...context.compilerOptions, allowJs: true, noLib: true, types: [], noResolve: false, noEmit: true,
	};
	const host = ts.createCompilerHost(options, true);
	const sameFile = (filename: string): boolean => path.resolve(filename) === path.resolve(source.fileName);
	const readFile = context.readFile ?? host.readFile;
	const fileExists = context.fileExists ?? host.fileExists;
	host.readFile = filename => sameFile(filename) ? source.text : readFile(filename);
	host.fileExists = filename => sameFile(filename) || fileExists(filename);
	if (context.directoryExists) { host.directoryExists = context.directoryExists; }
	host.getSourceFile = (filename, languageVersion) => {
		if (sameFile(filename)) { return source; }
		const text = host.readFile(filename);
		return text === undefined ? undefined : ts.createSourceFile(filename, text, languageVersion, true);
	};
	const checker = ts.createProgram([source.fileName], options, host).getTypeChecker();
	const identifiers: ts.Identifier[] = [];
	const documentedNames = new Set<string>();
	const inspectedDocs = new Set<ts.Node>();
	let hasJsx = false;
	let hasEval = false;
	const collect = (node: ts.Node): void => {
		if (ts.isIdentifier(node)) { identifiers.push(node); }
		hasJsx ||= ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
		hasEval ||= ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval';
		for (const doc of ts.getJSDocCommentsAndTags(node)) {
			if (inspectedDocs.has(doc)) { continue; }
			inspectedDocs.add(doc);
			const inspectDoc = (part: ts.Node): void => {
				if (ts.isIdentifier(part)) { documentedNames.add(part.text); }
				ts.forEachChild(part, inspectDoc);
			};
			inspectDoc(doc);
		}
		ts.forEachChild(node, collect);
	};
	collect(source);
	const factories = new Set([(options.jsxFactory ?? 'React.createElement').split('.')[0], (options.jsxFragmentFactory ?? 'React.Fragment').split('.')[0]]);
	for (const comment of ts.getLeadingCommentRanges(source.text, 0) ?? []) {
		for (const match of source.text.slice(comment.pos, comment.end).matchAll(/@jsx(?:Frag)?\s+([\w$]+)/g)) { factories.add(match[1]); }
	}
	for (const statement of candidates) {
		const clause = statement.importClause!;
		const namespace = clause.namedBindings as ts.NamespaceImport;
		const name = namespace.name.text;
		const skip = (reason: string): void => { result.skipped.push({ name, reason }); };
		if (documentedNames.has(name)) { skip('JSDoc references still need the namespace.'); continue; }
		if (hasEval || hasJsx && factories.has(name)) { skip('eval or an implicit JSX factory may use the namespace.'); continue; }
		if (statement.attributes || clause.phaseModifier === ts.SyntaxKind.DeferKeyword || hasComments(statement.getText(source))) {
			skip('The import contains comments, attributes, or a deferred binding.'); continue;
		}
		const symbol = checker.getSymbolAtLocation(namespace.name);
		if (!symbol) { skip('The namespace binding could not be resolved.'); continue; }
		const module = checker.getAliasedSymbol(symbol);
		if (module.exports?.has('export=' as ts.__String)) { skip('The module uses export = rather than named exports.'); continue; }
		const exportedNames = new Set(checker.getExportsOfModule(module).map(exported => exported.name));
		const accesses: Array<ts.PropertyAccessExpression | ts.QualifiedName> = [];
		let reason: string | undefined;
		for (const identifier of identifiers) {
			if (identifier === namespace.name) { continue; }
			const referenced = ts.isShorthandPropertyAssignment(identifier.parent) ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
				: ts.isExportSpecifier(identifier.parent) ? checker.getExportSpecifierLocalTargetSymbol(identifier.parent) : checker.getSymbolAtLocation(identifier);
			if (referenced !== symbol) { continue; }
			const access = identifier.parent;
			if (!(ts.isPropertyAccessExpression(access) && access.expression === identifier || ts.isQualifiedName(access) && access.left === identifier)) {
				reason = 'The namespace is used as an object or through computed access.'; break;
			}
			if (ts.isPropertyAccessExpression(access) && (access.questionDotToken || isWrite(access))) {
				reason = 'The namespace has optional access or writes.'; break;
			}
			const member = ts.isPropertyAccessExpression(access) ? access.name : access.right;
			if (!exportedNames.has(member.text)) { reason = 'A named export could not be resolved in the imported module.'; break; }
			if (!ts.isIdentifier(member) || member.text === 'default' || hasComments(access.getText(source))
				|| ts.isJsxOpeningLikeElement(access.parent) || ts.isJsxClosingElement(access.parent)) {
				reason = 'A member access has unsupported syntax, comments, or default interop.'; break;
			}
			if (ts.isPropertyAccessExpression(access) && isReceiverCall(access) && !receiverIndependent(access, checker)) {
				reason = 'A called export may depend on its namespace receiver, or its implementation is unavailable.'; break;
			}
			accesses.push(access);
		}
		if (reason || accesses.length === 0) { skip(reason ?? 'The namespace has no convertible member references.'); continue; }
		const memberNodes = new Set(accesses.map(access => ts.isPropertyAccessExpression(access) ? access.name : access.right));
		const reserved = new Set(identifiers.filter(identifier => !memberNodes.has(identifier)).map(identifier => identifier.text));
		const names = new Map<string, string>();
		for (const access of accesses) {
			const member = (ts.isPropertyAccessExpression(access) ? access.name : access.right).text;
			if (names.has(member)) { continue; }
			const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, member);
			const base = scanner.scan() === ts.SyntaxKind.Identifier ? member : `${name}_${member}`;
			let local = base;
			for (let suffix = 1; reserved.has(local); suffix += 1) { local = `${name}_${base}${suffix > 1 ? suffix : ''}`; }
			reserved.add(local); names.set(member, local);
		}
		const specifiers = [...names].map(([member, local]) => member === local ? member : `${member} as ${local}`);
		const edits: OffsetEdit[] = [{ start: namespace.getStart(source), end: namespace.getEnd(), newText: `{ ${specifiers.join(', ')} }` }];
		for (const access of accesses) {
			const member = (ts.isPropertyAccessExpression(access) ? access.name : access.right).text;
			edits.push({ start: access.getStart(source), end: access.getEnd(), newText: names.get(member)! });
		}
		result.fixes.push({ name, moduleName: (statement.moduleSpecifier as ts.StringLiteral).text, start: statement.getStart(source), end: statement.getEnd(), edits });
	}
	return result;
}
