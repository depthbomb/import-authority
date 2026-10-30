import type { CommentRange } from './model';

export type Token = {
	kind:      'identifier' | 'string' | 'number' | 'punctuation' | 'eof';
	text:      string;
	start:     number;
	end:       number;
	fullStart: number;
	lineBreak: boolean;
};

const identifierStart = /[$_\p{ID_Start}]/u;
const identifierPart  = /[$\u200c\u200d\p{ID_Continue}]/u;
const punctuation = /^(?:===|!==|\*\*=|&&=|\|\|=|\?\?=|\.\.\.|=>|==|!=|<=|>=|\+\+|--|&&|\|\||\?\?|\?\.|\*\*|\+=|-=|\*=|\/=|%=|&=|\|=|\^=)/;

function startsIdentifier(code: number): boolean {
	return code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 36 || code === 95
		|| code > 127 && identifierStart.test(String.fromCodePoint(code));
}

function continuesIdentifier(code: number): boolean {
	return code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 36 || code === 95
		|| code > 127 && identifierPart.test(String.fromCodePoint(code));
}

export class Scanner {
	public position = 0;
	public readonly comments: CommentRange[] = [];
	public readonly errors: string[] = [];

	public constructor(public readonly text: string) {}

	public next(jsxString = false): Token {
		const fullStart = this.position;
		let lineBreak   = false;
		while (this.position < this.text.length) {
			const character = this.text[this.position];
			const code = this.text.charCodeAt(this.position);
			if (code === 32 || code >= 9 && code <= 13 || code > 127 && /\s/.test(character)) {
				lineBreak ||= code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
				this.position++;
				continue;
			}

			if (this.position === 0 && this.text.startsWith('#!')) {
				while (this.position < this.text.length && !/[\r\n]/.test(this.text[this.position])) {
					this.position++;
				}
				continue;
			}

			const block = this.text.startsWith('/*', this.position);
			if (block || this.text.startsWith('//', this.position)) {
				const start = this.position;
				if (block) {
					const end = this.text.indexOf('*/', start + 2);
					if (end < 0) {
						this.errors.push('Unterminated comment');
					}

					this.position = end < 0 ? this.text.length : end + 2;
					lineBreak ||= /[\r\n\u2028\u2029]/.test(this.text.slice(start, this.position));
				} else {
					while (this.position < this.text.length && !/[\r\n\u2028\u2029]/.test(this.text[this.position])) {
						this.position++;
					}
				}

				this.comments.push({
					pos: start,
					end: this.position,
					block
				});
				continue;
			}
			break;
		}

		const start = this.position;
		let kind: Token['kind'] = 'punctuation';
		let value       = '';
		const character = this.text[start];
		if (start === this.text.length) {
			kind = 'eof';
		} else if (character === '"' || character === "'") {
			kind = 'string';
			this.position++;
			let closed = false;
			while (this.position < this.text.length) {
				const current = this.text[this.position++];
				if (current === character) {
					closed = true;
					break;
				}

				if (current === '\\' && !jsxString) {
					value += this.escape();
				} else if (/[\r\n]/.test(current) && !jsxString) {
					break;
				} else {
					value += current;
				}
			}

			if (!closed) {
				this.errors.push('Unterminated string');
			}
		} else if (startsIdentifier(this.text.codePointAt(start) ?? 0) || character === '\\') {
			kind = 'identifier';
			while (this.position < this.text.length) {
				const code = this.text.codePointAt(this.position)!;
				if (code === 92 && this.text[this.position + 1] === 'u') {
					this.position++;
					const decoded = this.escape();
					if (!(value.length ? identifierPart : identifierStart).test(decoded)) {
						this.errors.push('Invalid identifier escape');
					}

					value += decoded;
				} else if (value.length ? continuesIdentifier(code) : startsIdentifier(code)) {
					value += String.fromCodePoint(code);
					this.position += code > 0xffff ? 2 : 1;
				} else {
					if (this.position === start) {
						this.position += code > 0xffff ? 2 : 1;
						this.errors.push('Invalid identifier');
					}
					break;
				}
			}
		} else if (/[0-9]/.test(character) || character === '.' && /[0-9]/.test(this.text[start + 1] ?? '')) {
			kind = 'number';
			const match = /^(?:0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?n?)/.exec(this.text.slice(start));
			this.position += match?.[0].length ?? 1;
			value = this.text.slice(start, this.position);
			const radix = /^0[xXbBoO]/.test(value);
			if (/(?:__|_$|_n$)/.test(value) || /^0[xXbBoO]_/.test(value)
				|| !radix && (/(?:_[.eE]|[.eE][+-]?_)/.test(value) || /^0[0-9_]+/.test(value) || value.endsWith('n') && /[.eE]/.test(value))
				|| startsIdentifier(this.text.codePointAt(this.position) ?? 0)) {
				this.errors.push('Invalid numeric literal');
			}
		} else {
			value = punctuation.exec(this.text.slice(start))?.[0] ?? character;
			this.position += value.length;
		}

		return {
			kind,
			text: value,
			start,
			end:  this.position,
			fullStart,
			lineBreak
		};
	}

	public peek(): Token {
		const position = this.position;
		const comments = this.comments.length;
		const errors   = this.errors.length;
		const token    = this.next();
		this.position = position;
		this.comments.length = comments;
		this.errors.length = errors;

		return token;
	}

	public scanEscape(position: number): number {
		this.position = position;
		this.escape();

		return this.position;
	}

	private escape(): string {
		const character = this.text[this.position++];
		const simple: Record<string, string> = {
			n:   '\n',
			r:   '\r',
			t:   '\t',
			b:   '\b',
			f:   '\f',
			v:   '\v',
			'0': '\0'
		};
		if (/[1-9]/.test(character ?? '') || character === '0' && /[0-9]/.test(this.text[this.position] ?? '')) {
			this.errors.push('Legacy numeric escapes are not supported');
		}
		if (character === '\r' || character === '\n' || character === '\u2028' || character === '\u2029') {
			if (character === '\r' && this.text[this.position] === '\n') {
				this.position++;
			}

			return '';
		}

		if (character === 'u' || character === 'x') {
			const braced = character === 'u' && this.text[this.position] === '{';
			const start  = this.position + Number(braced);
			const end    = braced ? this.text.indexOf('}', start) : start + (character === 'u' ? 4 : 2);
			const digits = this.text.slice(start, end);
			const value  = Number.parseInt(digits, 16);
			if (end < start || end > this.text.length || !/^[\da-fA-F]+$/.test(digits) || value > 0x10ffff) {
				this.errors.push('Invalid character escape');

				return '';
			}

			this.position = end + Number(braced);

			return String.fromCodePoint(value);
		}

		return simple[character] ?? character ?? '';
	}
}

export function getLeadingCommentRanges(text: string, position: number): CommentRange[] {
	const scanner = new Scanner(text);
	scanner.position = position;
	scanner.next();
	let lineBreak = position === 0;
	let previous  = position;

	return scanner.comments.filter(comment => {
		lineBreak ||= /[\r\n\u2028\u2029]/.test(text.slice(previous, comment.pos));
		previous = comment.end;
		const leading = lineBreak;
		lineBreak ||= /[\r\n\u2028\u2029]/.test(text.slice(comment.pos, comment.end));

		return leading;
	});
}

export function getTrailingCommentRanges(text: string, position: number): CommentRange[] {
	const scanner = new Scanner(text);
	scanner.position = position;
	scanner.next();
	const result: CommentRange[] = [];
	let previous = position;
	for (const comment of scanner.comments) {
		if (/[\r\n\u2028\u2029]/.test(text.slice(previous, comment.pos))) {
			break;
		}

		result.push(comment);
		previous = comment.end;
		if (/[\r\n\u2028\u2029]/.test(text.slice(comment.pos, comment.end))) {
			break;
		}
	}

	return result;
}

export function hasCommentTrivia(text: string): boolean {
	const scanner = new Scanner(text);
	while (scanner.next().kind !== 'eof') {
		if (scanner.comments.length) {
			return true;
		}
	}

	return scanner.comments.length > 0;
}
