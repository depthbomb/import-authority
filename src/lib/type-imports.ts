import * as syntax from './syntax';
import type { OffsetEdit } from './text-edit';

type Usage = { type: boolean; value: boolean };

export function convertTypeOnlyImports(
	source: syntax.SourceFile,
	imports: syntax.ImportDeclaration[],
	compilerOptions: { jsxFactory?: string; jsxFragmentFactory?: string } = {},
	inlineTypes = false,
): { content: string; converted: number; edits: OffsetEdit[]; note?: string } {
	const unchanged = {
		content:   source.text,
		converted: 0,
		edits:     []
	};
	if (!/\.(?:ts|tsx|mts|cts)$/i.test(source.fileName) || imports.length === 0) {
		return unchanged;
	}

	if (source.hasDecorators || source.hasEval) {
		return {
			...unchanged,
			note: 'Type-import conversion skipped because decorators or eval may use imports implicitly.'
		};
	}

	const factoryNames = new Set([
		(compilerOptions.jsxFactory ?? 'React.createElement').split('.')[0],
		(compilerOptions.jsxFragmentFactory ?? 'React.Fragment').split('.')[0],
	]);
	for (const comment of syntax.getLeadingCommentRanges(source.text, 0)) {
		for (const match of source.text.slice(comment.pos, comment.end).matchAll(/@jsx(?:Frag)?\s+([\w$]+)/g)) {
			factoryNames.add(match[1]);
		}
	}

	const candidates = imports.filter(statement => statement.importClause && !statement.importClause.isTypeOnly
		&& !statement.importClause.phaseModifier && !statement.attributes && !syntax.hasCommentTrivia(statement.getText()));
	const explicitTypes = new Set(imports.flatMap(statement => {
		const named = statement.importClause?.namedBindings;

		return named && syntax.isNamedImports(named) ? named.elements.filter(element => element.isTypeOnly).map(element => element.name.start) : [];
	}));
	const usages = new Map<number, Usage>();
	for (const reference of source.references) {
		const binding = syntax.resolveReference(reference);
		if (!binding?.import) {
			continue;
		}

		const usage = usages.get(binding.start) ?? {
			type:  false,
			value: source.hasJsx && factoryNames.has(binding.name)
		};
		usage.type ||= reference.typeOnly;
		usage.value ||= !reference.typeOnly;
		usages.set(binding.start, usage);
	}

	const onlyType = (name: syntax.TextNode | undefined): boolean => {
		const usage = name && usages.get(name.start);

		return !!name && !explicitTypes.has(name.start) && !!usage?.type && !usage.value;
	};
	const edits   = [] as Array<{ start: number; end: number; text: string }>;
	let converted = 0;
	const eol     = source.text.includes('\r\n') ? '\r\n' : '\n';

	for (const statement of candidates) {
		const clause   = statement.importClause!;
		const named    = clause.namedBindings;
		const elements = named && syntax.isNamedImports(named) ? [...named.elements] : [];
		const convertedNames = elements.filter(element => onlyType(element.name));
		const typeDefault   = onlyType(clause.name);
		const typeNamespace = !!named && syntax.isNamespaceImport(named) && onlyType(named.name);
		if (!typeDefault && !typeNamespace && convertedNames.length === 0) {
			continue;
		}

		converted += Number(typeDefault) + Number(typeNamespace) + convertedNames.length;

		const values = elements.filter(element => !element.isTypeOnly && !onlyType(element.name));
		const types = elements.filter(element => element.isTypeOnly || onlyType(element.name));
		const specifier = (element: syntax.ImportSpecifier): string => element.propertyName
			? `${element.propertyName.getText(source)} as ${element.name.text}` : element.name.text;
		const from       = ` from ${statement.moduleSpecifier.getText(source)}${statement.getText(source).trimEnd().endsWith(';') ? ';' : ''}`;
		const result     = [] as string[];
		const valueParts = [] as string[];

		if (clause.name && !typeDefault) {
			valueParts.push(clause.name.text);
		}

		if (named && syntax.isNamespaceImport(named) && !typeNamespace) {
			valueParts.push(named.getText(source));
		}

		const keepInline = inlineTypes && (valueParts.length > 0 || values.length > 0);
		const namedParts = [...values.map(specifier), ...(keepInline ? types.map(element => `type ${specifier(element)}`) : [])];
		if (namedParts.length > 0) {
			valueParts.push(`{ ${namedParts.join(', ')} }`);
		}

		if (named && syntax.isNamedImports(named) && elements.length === 0) {
			valueParts.push('{}');
		}

		if (valueParts.length > 0) {
			result.push(`import ${valueParts.join(', ')}${from}`);
		}

		if (typeDefault) {
			result.push(`import type ${clause.name!.text}${from}`);
		}

		if (typeNamespace) {
			result.push(`import type ${named!.getText(source)}${from}`);
		}

		if (types.length > 0 && !keepInline) {
			result.push(`import type { ${types.map(specifier).join(', ')} }${from}`);
		}

		edits.push({
			start: statement.getStart(source),
			end:   statement.getEnd(),
			text:  result.join(eol)
		});
	}

	let cursor   = 0;
	const chunks = [] as string[];

	for (const edit of edits) {
		chunks.push(source.text.slice(cursor, edit.start), edit.text);
		cursor = edit.end;
	}

	chunks.push(source.text.slice(cursor));

	return {
		content: chunks.join(''),
		converted,
		edits:   edits.map(edit => ({
			start:   edit.start,
			end:     edit.end,
			newText: edit.text
		}))
	};
}
