import { Scanner } from './scanner';
import type { SourceFile } from './model';

function collect(text: string, identifiers: Set<string>): void {
	const scanner = new Scanner(text);
	for (let token = scanner.next(); token.kind !== 'eof'; token = scanner.next()) {
		if (token.kind === 'identifier') {
			identifiers.add(token.text);
		}
	}
}

export function jsdocIdentifiers(source: SourceFile): Set<string> {
	const identifiers = new Set<string>();
	for (const comment of source.comments) {
		if (!source.jsdocComments.has(comment.pos) || !source.text.startsWith('/**', comment.pos)) {
			continue;
		}

		const text = source.text.slice(comment.pos + 3, comment.end - 2).replace(/^\s*\* ?/gm, '');
		for (const link of text.matchAll(/\{@link(?:code|plain)?\s+([^\s|}]+)/g)) {
			collect(link[1], identifiers);
		}

		const tags = [...text.matchAll(/(?:^|\s)@([$\w]+)/g)];
		let properties = false;
		for (let index = 0; index < tags.length; index++) {
			const tag = tags[index];
			identifiers.add(tag[1]);
			let value = text.slice(tag.index! + tag[0].length, tags[index + 1]?.index).trimStart();
			if (/^(?:property|prop)$/.test(tag[1]) && !properties) {
				continue;
			}

			if (tag[1] === 'typedef') {
				properties = /^\{(?:Object|object)(?:\[\])?\}/.test(value);
			}

			const typed = /^(?:type|param|arg|argument|returns?|typedef|property|prop|extends|augments|implements|this|enum|throws|satisfies|template)$/.test(tag[1]);
			if (typed && value.startsWith('{')) {
				let depth = 1;
				let cursor = 1;
				while (cursor < value.length && depth) {
					depth += Number(value[cursor] === '{') - Number(value[cursor] === '}');
					cursor++;
				}

				collect(value.slice(1, depth ? cursor : cursor - 1), identifiers);
				value = value.slice(cursor).trimStart();
			} else if (/^(?:type|extends|augments|implements|this|enum|satisfies)$/.test(tag[1])) {
				collect(value.split(/\s/)[0], identifiers);
			}

			if (tag[1] === 'template') {
				const parameters = /^(?:\[[^\]]*\]|[$\p{ID_Start}][$\p{ID_Continue}]*)(?:\s*,\s*(?:\[[^\]]*\]|[$\p{ID_Start}][$\p{ID_Continue}]*))*/u.exec(value)?.[0];
				if (parameters) {
					collect(parameters, identifiers);
				}
			} else if (tag[1] === 'import') {
				collect(value.split(/\s+from\s+/)[0], identifiers);
			} else if (/^(?:param|arg|argument|typedef|property|prop|callback|see)$/.test(tag[1])) {
				const name = /^\[?([^\s=\]]+)/.exec(value)?.[1];
				if (name) {
					collect(name, identifiers);
				}
			}
		}
	}

	return identifiers;
}
