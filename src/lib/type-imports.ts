import ts from 'typescript';

type Usage = { type: boolean; value: boolean };

function isTypeUse(node: ts.Identifier): boolean {
	if (ts.isExportSpecifier(node.parent)) {
		return node.parent.isTypeOnly || node.parent.parent.parent.isTypeOnly;
	}
	let target: ts.Node = node;
	while (ts.isQualifiedName(target.parent) || ts.isPropertyAccessExpression(target.parent)) { target = target.parent; }
	return ts.isTypeQueryNode(target.parent) || ts.isPartOfTypeNode(target);
}

/** Bind local aliases without resolving dependencies or loading a project. */
export function convertTypeOnlyImports(
	source: ts.SourceFile,
	imports: ts.ImportDeclaration[],
	compilerOptions: ts.CompilerOptions = {},
	inlineTypes = false,
): { content: string; converted: number; note?: string } {
	const unchanged = { content: source.text, converted: 0 };
	if (!/\.(?:ts|tsx|mts|cts)$/i.test(source.fileName) || imports.length === 0) { return unchanged; }
	let hasDecorators = false;
	let hasJsx = false;
	let hasEval = false;
	const inspect = (node: ts.Node): void => {
		hasDecorators ||= ts.isDecorator(node);
		hasJsx ||= ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
		hasEval ||= ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval';
		ts.forEachChild(node, inspect);
	};
	inspect(source);
	if (hasDecorators || hasEval) {
		return { ...unchanged, note: 'Type-import conversion skipped because decorators or eval may use imports implicitly.' };
	}
	const factoryNames = new Set([
		(compilerOptions.jsxFactory ?? 'React.createElement').split('.')[0],
		(compilerOptions.jsxFragmentFactory ?? 'React.Fragment').split('.')[0],
	]);
	for (const comment of ts.getLeadingCommentRanges(source.text, 0) ?? []) {
		for (const match of source.text.slice(comment.pos, comment.end).matchAll(/@jsx(?:Frag)?\s+([\w$]+)/g)) { factoryNames.add(match[1]); }
	}
	const candidates = imports.filter(statement => {
		if (!statement.importClause || statement.importClause.isTypeOnly || statement.importClause.phaseModifier
			|| statement.attributes || !ts.isStringLiteral(statement.moduleSpecifier)) { return false; }
		const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, statement.getText(source));
		for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
			if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) { return false; }
		}
		return true;
	});
	if (candidates.length === 0) { return unchanged; }
	const host: ts.CompilerHost = {
		getSourceFile: filename => filename === source.fileName ? source : undefined,
		getDefaultLibFileName: () => '', writeFile: () => undefined, getCurrentDirectory: () => '',
		getCanonicalFileName: filename => filename, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
		fileExists: filename => filename === source.fileName,
		readFile: filename => filename === source.fileName ? source.text : undefined,
	};
	const checker = ts.createProgram([source.fileName], {
		noResolve: true, noLib: true, target: ts.ScriptTarget.Latest,
	}, host).getTypeChecker();
	const usages = new Map<ts.Symbol, Usage>();
	const bindings = new Map<ts.Identifier, Usage>();
	for (const statement of candidates) {
		const clause = statement.importClause!;
		const named = clause.namedBindings;
		const names = [clause.name, ...(named ? ts.isNamespaceImport(named) ? [named.name]
			: named.elements.filter(element => !element.isTypeOnly).map(element => element.name) : [])];
		for (const name of names) {
			if (!name) { continue; }
			const symbol = checker.getSymbolAtLocation(name);
			if (!symbol) { continue; }
			const usage = usages.get(symbol) ?? { type: false, value: hasJsx && factoryNames.has(name.text) };
			usages.set(symbol, usage);
			bindings.set(name, usage);
		}
	}
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) { return; }
		if (ts.isIdentifier(node)) {
			const symbol = ts.isShorthandPropertyAssignment(node.parent)
				? checker.getShorthandAssignmentValueSymbol(node.parent)
				: ts.isExportSpecifier(node.parent) ? checker.getExportSpecifierLocalTargetSymbol(node.parent)
					: checker.getSymbolAtLocation(node);
			const usage = symbol && usages.get(symbol);
			if (usage) { if (isTypeUse(node)) { usage.type = true; } else { usage.value = true; } }
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	const onlyType = (name: ts.Identifier | undefined): boolean => {
		const usage = name && bindings.get(name);
		return !!usage?.type && !usage.value;
	};
	const edits: Array<{ start: number; end: number; text: string }> = [];
	let converted = 0;
	const eol = source.text.includes('\r\n') ? '\r\n' : '\n';
	for (const statement of candidates) {
		const clause = statement.importClause!;
		const named = clause.namedBindings;
		const elements = named && ts.isNamedImports(named) ? [...named.elements] : [];
		const convertedNames = elements.filter(element => onlyType(element.name));
		const typeDefault = onlyType(clause.name);
		const typeNamespace = !!named && ts.isNamespaceImport(named) && onlyType(named.name);
		if (!typeDefault && !typeNamespace && convertedNames.length === 0) { continue; }
		converted += Number(typeDefault) + Number(typeNamespace) + convertedNames.length;
		const values = elements.filter(element => !element.isTypeOnly && !onlyType(element.name));
		const types = elements.filter(element => element.isTypeOnly || onlyType(element.name));
		const specifier = (element: ts.ImportSpecifier): string => element.propertyName
			? `${element.propertyName.getText(source)} as ${element.name.text}` : element.name.text;
		const from = ` from ${statement.moduleSpecifier.getText(source)}${statement.getText(source).trimEnd().endsWith(';') ? ';' : ''}`;
		const result: string[] = [];
		const valueParts: string[] = [];
		if (clause.name && !typeDefault) { valueParts.push(clause.name.text); }
		if (named && ts.isNamespaceImport(named) && !typeNamespace) { valueParts.push(named.getText(source)); }
		const keepInline = inlineTypes && (valueParts.length > 0 || values.length > 0);
		const namedParts = [...values.map(specifier), ...(keepInline ? types.map(element => `type ${specifier(element)}`) : [])];
		if (namedParts.length > 0) { valueParts.push(`{ ${namedParts.join(', ')} }`); }
		if (named && ts.isNamedImports(named) && elements.length === 0) { valueParts.push('{}'); }
		if (valueParts.length > 0) { result.push(`import ${valueParts.join(', ')}${from}`); }
		if (typeDefault) { result.push(`import type ${clause.name!.text}${from}`); }
		if (typeNamespace) { result.push(`import type ${named!.getText(source)}${from}`); }
		if (types.length > 0 && !keepInline) { result.push(`import type { ${types.map(specifier).join(', ')} }${from}`); }
		edits.push({ start: statement.getStart(source), end: statement.getEnd(), text: result.join(eol) });
	}
	let cursor = 0;
	const chunks: string[] = [];
	for (const edit of edits) { chunks.push(source.text.slice(cursor, edit.start), edit.text); cursor = edit.end; }
	chunks.push(source.text.slice(cursor));
	return { content: chunks.join(''), converted };
}
