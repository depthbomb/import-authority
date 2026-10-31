import { ModuleResolver } from './module-resolver';
import type { ResolutionContext, ResolvedExport } from './module-resolver';
import { getLeadingCommentRanges, hasCommentTrivia, isNamespaceImport, resolveReference } from './syntax';
import type { SourceFile, ImportDeclaration, Reference } from './syntax';
import type { OffsetEdit } from './text-edit';
import { jsdocIdentifiers } from './syntax/jsdoc';

export type NamespaceConversionContext = ResolutionContext;
export type NamespaceImportFix = {
	name:       string;
	moduleName: string;
	start:      number;
	end:        number;
	edits:      OffsetEdit[];
};
export type NamespaceConversionResult = {
	fixes:   NamespaceImportFix[];
	skipped: Array<{ name: string; reason: string }>;
};

const keywords = new Set(('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with implements interface let package private protected public static yield abstract accessor as asserts assert any async await boolean constructor declare get infer intrinsic is keyof module namespace never out readonly require number object satisfies set string symbol type undefined unique unknown using from global bigint of override').split(' '));

function receiverIndependent(exported: ResolvedExport): boolean {
	const binding = exported.binding;
	if (!binding?.constant || !binding.function?.body || binding.function.dependent) {
		return false;
	}

	// The original receiver check also inspected property and declaration names.
	for (const [position, name] of exported.source.identifierPositions) {
		if (name === 'eval' || name === 'arguments' && position >= binding.function.start && position < binding.function.end) {
			return false;
		}
	}

	return !exported.source.references.some(reference => reference.written && resolveReference(reference) === binding);
}

export function planNamespaceImports(source: SourceFile, imports: ImportDeclaration[], context: NamespaceConversionContext = {}): NamespaceConversionResult {
	const result: NamespaceConversionResult = {
		fixes:   [],
		skipped: []
	};
	const candidates = imports.filter(statement => statement.importClause?.namedBindings && isNamespaceImport(statement.importClause.namedBindings));
	if (!candidates.length) {
		return result;
	}

	const resolver = new ModuleResolver(source, context);
	const documentedNames = jsdocIdentifiers(source);
	const factories = new Set([
		(context.compilerOptions?.jsxFactory ?? 'React.createElement').split('.')[0],
		(context.compilerOptions?.jsxFragmentFactory ?? 'React.Fragment').split('.')[0],
	]);
	for (const comment of getLeadingCommentRanges(source.text, 0)) {
		for (const match of source.text.slice(comment.pos, comment.end).matchAll(/@jsx(?:Frag)?\s+([\w$]+)/g)) {
			factories.add(match[1]);
		}
	}

	for (const statement of candidates) {
		const namespace = statement.importClause!.namedBindings!;
		if (!isNamespaceImport(namespace)) {
			continue;
		}

		const name = namespace.name.text;
		const skip = (reason: string): void => {
			result.skipped.push({
				name,
				reason
			});
		};
		if (documentedNames.has(name)) {
			skip('JSDoc references still need the namespace.');
			continue;
		}

		if (source.hasEval || source.hasJsx && factories.has(name)) {
			skip('eval or an implicit JSX factory may use the namespace.');
			continue;
		}

		if (statement.attributes || statement.importClause?.phaseModifier === 'defer' || hasCommentTrivia(statement.getText())) {
			skip('The import contains comments, attributes, or a deferred binding.');
			continue;
		}

		const binding = source.scope.bindings.get(name)?.find(binding => binding.start === namespace.name.start);
		const target = resolver.resolve(statement.moduleSpecifier.text, source.fileName);
		const module = target && resolver.source(target);
		if (module && module.exportEquals) {
			skip('The module uses export = rather than named exports.');
			continue;
		}

		const references = source.references.filter(reference => resolveReference(reference) === binding);
		const accesses: Reference[] = [];
		let reason: string | undefined;
		for (const reference of references) {
			const member = reference.member;
			if (!member || member.computed) {
				reason = 'The namespace is used as an object or through computed access.';
				break;
			}

			if (member.optional || reference.written && !reference.typeOnly) {
				reason = 'The namespace has optional access or writes.';
				break;
			}

			const exported = target && resolver.exported(target, member.name);
			if (!exported) {
				reason = 'A named export could not be resolved in the imported module.';
				break;
			}

			if (member.name === 'default' || member.jsx || hasCommentTrivia(source.text.slice(member.start, member.end))) {
				reason = 'A member access has unsupported syntax, comments, or default interop.';
				break;
			}

			if (member.call && !receiverIndependent(exported)) {
				reason = 'A called export may depend on its namespace receiver, or its implementation is unavailable.';
				break;
			}

			accesses.push(reference);
		}

		if (reason || accesses.length === 0) {
			skip(reason ?? 'The namespace has no convertible member references.');
			continue;
		}

		const memberPositions = new Set(accesses.map(reference => reference.member!.nameStart));
		const reserved = new Set([...source.identifierPositions].filter(([position]) => !memberPositions.has(position)).map(([, name]) => name));
		const names = new Map<string, string>();
		for (const reference of accesses) {
			const member = reference.member!.name;
			if (names.has(member)) {
				continue;
			}

			const base = keywords.has(member) ? `${name}_${member}` : member;
			let local  = base;
			for (let suffix = 1; reserved.has(local); suffix++) {
				local = `${name}_${base}${suffix > 1 ? suffix : ''}`;
			}

			reserved.add(local);
			names.set(member, local);
		}

		const specifiers = [...names].map(([member, local]) => member === local ? member : `${member} as ${local}`);
		const edits: OffsetEdit[] = [{
			start:   namespace.start,
			end:     namespace.end,
			newText: `{ ${specifiers.join(', ')} }`
		}];
		for (const reference of accesses) {
			const member = reference.member!;
			edits.push({
				start:   member.start,
				end:     member.end,
				newText: names.get(member.name)!
			});
		}

		result.fixes.push({
			name,
			moduleName: statement.moduleSpecifier.text,
			start:      statement.start,
			end:        statement.end,
			edits
		});
	}

	return result;
}
