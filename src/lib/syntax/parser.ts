import { Scanner, getLeadingCommentRanges, getTrailingCommentRanges } from './scanner';
import type { Token } from './scanner';
import { TextNode } from './model';
import type {
	Binding, ExportEntry, FunctionInfo, ImportClause, ImportDeclaration, ImportSpecifier,
	Meaning, Reference, Scope, SourceFile,
} from './model';

type Expression = {
	start:           number;
	end:             number;
	reference?:      Reference;
	depth:           number;
	function?:       FunctionInfo;
	commonJsExport?: string;
};
type Lookahead = {
	depth:   number;
	results: Map<string, boolean>;
};

const binaryPrecedence = new Map([
	[',', 1], ['=', 2], ['+=', 2], ['-=', 2], ['*=', 2], ['/=', 2], ['%=', 2], ['**=', 2],
	['<<=', 2], ['>>=', 2], ['>>>=', 2], ['&&=', 2], ['||=', 2], ['??=', 2], ['&=', 2], ['|=', 2], ['^=', 2],
	['??', 4], ['||', 4], ['&&', 5], ['|', 6], ['^', 7], ['&', 8],
	['==', 9], ['!=', 9], ['===', 9], ['!==', 9], ['<', 10], ['>', 10], ['<=', 10], ['>=', 10],
	['in', 10], ['instanceof', 10], ['as', 10], ['satisfies', 10],
	['<<', 11], ['>>', 11], ['>>>', 11], ['+', 12], ['-', 12], ['*', 13], ['/', 13], ['%', 13], ['**', 14],
]);
const modifiers       = new Set(['public', 'private', 'protected', 'static', 'abstract', 'readonly', 'override', 'declare', 'accessor']);
const primitiveTypes  = new Set(['any', 'unknown', 'never', 'void', 'undefined', 'null', 'string', 'number', 'boolean', 'bigint', 'symbol', 'object', 'true', 'false', 'this', 'intrinsic']);
const invalidBindings = new Set(['const', 'let', 'var', 'return', 'throw', 'if', 'else', 'for', 'while', 'switch', 'case', 'default', 'try', 'catch', 'finally', 'class', 'function', 'import', 'export', 'extends', 'new', 'delete', 'typeof', 'instanceof', 'void', 'null', 'true', 'false']);

/* Records only syntax and binding information used by import transformations. */
class Parser {
	private token: Token;
	private end = 0;
	private scope: Scope;
	private allowIn = true;
	private statementReferences: Reference[] = [];
	private readonly functions: FunctionInfo[] = [];
	private readonly scanner: Scanner;
	private readonly source: SourceFile;

	public constructor(fileName: string, text: string, offset = 0, private readonly lookahead: Lookahead = {
		depth:   0,
		results: new Map()
	}) {
		this.scanner = new Scanner(text);
		this.scanner.position = offset;
		this.token = this.scanner.next();
		this.scope = {
			kind:     'module',
			bindings: new Map(),
			exports: []
		};
		this.source = {
			fileName,
			text,
			statements:          [],
			endOfFileToken:      new TextNode(text, text.length, text.length),
			comments:            this.scanner.comments,
			jsdocComments:       new Set(),
			parseDiagnostics:    this.scanner.errors,
			scope:               this.scope,
			references:          [],
			identifierPositions: new Map(),
			exports:             this.scope.exports!,
			ambientModules:      new Map(),
			exportEquals:        false,
			hasJsx:              false,
			hasDecorators:       false,
			hasEval:             false,
		};
	}

	public parse(): SourceFile {
		try {
			while (this.token.kind !== 'eof') {
				const start     = this.token.start;
				const fullStart = this.end;
				const statement = this.statement(true);
				const node      = statement ?? new TextNode(this.source.text, start, this.end, fullStart);
				node.parent = this.source;
				this.source.statements.push(node);
				if (this.token.start === start) {
					this.fail('Expected a statement');
				}
			}
		} catch (error) {
			if (!(error instanceof SyntaxError) && !(error instanceof RangeError)) {
				throw error;
			}

			this.source.parseDiagnostics.push(error.message);
		}

		this.source.endOfFileToken = new TextNode(this.source.text, this.source.text.length, this.source.text.length, this.end);
		this.source.endOfFileToken.parent = this.source;
		this.jsdoc();

		return this.source;
	}

	private isLiteral(): boolean {
		return this.token.kind === 'string' || this.token.kind === 'number';
	}

	private at(text: string): boolean {
		return this.token.kind !== 'string' && this.token.kind !== 'number' && this.token.text === text;
	}

	private next(jsxString = false): Token {
		const previous = this.token;
		this.end = previous.end;
		this.token = this.scanner.next(jsxString);

		return previous;
	}

	private take(text: string): boolean {
		if (text === '>' && this.token.text === '>=' && this.token.kind === 'punctuation') {
			this.resume(this.token.start + 1);

			return true;
		}

		if (!this.at(text)) {
			return false;
		}

		this.next();

		return true;
	}

	private expect(text: string): void {
		if (!this.take(text)) {
			this.fail(`Expected ${text}`);
		}
	}

	private fail(message: string): never {
		throw new SyntaxError(`${message} at ${this.token.start}`);
	}

	private jsdoc(inline = false): void {
		if (!this.source.text.slice(this.token.fullStart, this.token.start).includes('/**')) {
			return;
		}

		const comments = getLeadingCommentRanges(this.source.text, this.token.fullStart);
		if (inline) {
			comments.push(...getTrailingCommentRanges(this.source.text, this.token.fullStart));
		}

		for (const comment of comments) {
			this.source.jsdocComments.add(comment.pos);
		}
	}

	private name(binding = false): Token {
		if (this.token.kind !== 'identifier' || binding && invalidBindings.has(this.token.text)) {
			this.fail('Expected an identifier');
		}

		this.source.identifierPositions.set(this.token.start, this.token.text);

		return this.next();
	}

	private span(token: Token): TextNode {
		return new TextNode(this.source.text, token.start, token.end, token.fullStart, token.text);
	}

	private enter(kind: Scope['kind']): Scope {
		const previous = this.scope;
		this.scope = {
			parent:   previous,
			kind,
			bindings: new Map()
		};

		return previous;
	}

	private bind(token: Token, meaning: Meaning, constant = true, hoist = false): Binding {
		let scope = this.scope;
		while (hoist && scope.parent && !['function', 'module', 'static'].includes(scope.kind)) {
			scope = scope.parent;
		}

		const binding: Binding = {
			name:  token.text,
			start: token.start,
			scope,
			meaning,
			constant
		};
		const bindings = scope.bindings.get(token.text) ?? [];
		bindings.push(binding);
		scope.bindings.set(token.text, bindings);
		this.source.identifierPositions.set(token.start, token.text);
		if (scope.ambient) {
			this.publish(binding);
		}

		return binding;
	}

	private reference(token: Token, typeOnly = false, meaning: Meaning = typeOnly ? 1 : 2): Reference {
		const reference: Reference = {
			name:    token.text,
			start:   token.start,
			end:     token.end,
			scope:   this.scope,
			typeOnly,
			meaning,
			written: false,
		};
		this.source.references.push(reference);
		this.statementReferences.push(reference);
		this.source.identifierPositions.set(token.start, token.text);
		if (['this', 'super', 'eval', 'arguments'].includes(token.text)) {
			for (const fn of this.functions) {
				fn.dependent = true;
			}
		}

		return reference;
	}

	private semicolon(): void {
		if (!this.take(';') && !this.at('}') && this.token.kind !== 'eof' && !this.token.lineBreak) {
			this.fail('Expected a semicolon or line break');
		}
	}

	private statement(top = false, exported = false): ImportDeclaration | undefined {
		const previous = this.statementReferences;
		this.statementReferences = [];
		try {
			this.jsdoc();
			return this.readStatement(top, exported);
		} finally {
			this.statementReferences = previous;
		}
	}

	private readStatement(top: boolean, exported: boolean): ImportDeclaration | undefined {
		if (this.isLiteral()) {
			this.expression();
			this.semicolon();
			return;
		}

		if (this.take(';')) {
			return;
		}

		if (this.at('@')) {
			this.decorators();
		}

		if (this.at('export')) {
			this.exportStatement(top);
			return;
		}

		if (this.at('import') && !['(', '.'].includes(this.scanner.peek().text)) {
			return this.importDeclaration(top, exported);
		}

		const declared = this.at('declare') && this.scanner.peek().kind === 'identifier';
		if (declared) {
			this.next();
		}

		if (this.at('abstract') && this.scanner.peek().text === 'class') {
			this.next();
		}

		if (this.at('async') && this.scanner.peek().text === 'function' && !this.scanner.peek().lineBreak) {
			this.next();
		}

		if (this.at('function')) {
			this.functionDeclaration(true, exported);
			return;
		}

		if (this.at('class')) {
			this.classDeclaration(true, exported);
			return;
		}

		if (this.at('interface') && this.scanner.peek().kind === 'identifier') {
			this.next();
			const token = this.name(true);
			this.bind(token, 1);
			this.exportBinding(token, exported);
			const previous = this.enter('type');
			this.typeParameters();
			if (this.take('extends')) {
				do {
					this.type();
				} while (this.take(','));
			}

			this.typeObject();
			this.scope = previous;
			return;
		}

		if (this.at('type') && this.scanner.peek().kind === 'identifier') {
			this.next();
			const token = this.name(true);
			this.bind(token, 1);
			this.exportBinding(token, exported);
			const previous = this.enter('type');
			this.typeParameters();
			this.expect('=');
			this.type();
			this.scope = previous;
			this.semicolon();
			return;
		}

		if (this.at('const') && this.scanner.peek().text === 'enum') {
			this.next();
		}

		if (this.take('enum')) {
			const token = this.name(true);
			this.bind(token, 3);
			this.exportBinding(token, exported);
			const previous = this.enter('block');
			this.expect('{');
			while (!this.at('}')) {
				const member = this.propertyName();
				if (member) {
					this.bind(member, 2);
				}

				if (this.take('=')) {
					this.expression(2);
				}

				if (!this.take(',')) {
					break;
				}
			}

			this.expect('}');
			this.scope = previous;
			return;
		}

		if (['namespace', 'module'].includes(this.token.text) && ['identifier', 'string'].includes(this.scanner.peek().kind)
			|| this.at('global') && this.scanner.peek().text === '{') {
			this.namespaceDeclaration(exported, declared || !!this.scope.ambient || /\.d\.[cm]?ts$/i.test(this.source.fileName));
			return;
		}

		if (['var', 'let', 'const'].includes(this.token.text)
			|| this.at('using') && this.scanner.peek().kind === 'identifier'
			|| this.at('await') && this.scanner.peek().text === 'using') {
			this.variables(exported);
			this.semicolon();
			return;
		}

		if (this.at('{')) {
			this.block();
			return;
		}

		if (this.take('if')) {
			this.parenthesizedExpression();
			this.statement();
			if (this.take('else')) {
				this.statement();
			}
			return;
		}

		if (this.take('for')) {
			this.take('await');
			this.expect('(');
			const previous = this.enter('block');
			const allowIn  = this.allowIn;
			this.allowIn = false;
			if (['const', 'let', 'var', 'using'].includes(this.token.text)) {
				this.variables();
			} else if (!this.at(';')) {
				const target = this.expression();
				if (this.at('in') || this.at('of')) {
					this.write(target);
				}
			}

			this.allowIn = allowIn;
			if (this.take('in') || this.take('of')) {
				this.expression();
			} else {
				this.expect(';');
				if (!this.at(';')) {
					this.expression();
				}

				this.expect(';');
				if (!this.at(')')) {
					this.expression();
				}
			}

			this.expect(')');
			this.statement();
			this.scope = previous;
			return;
		}

		if (this.take('while') || this.take('with')) {
			this.parenthesizedExpression();
			this.statement();
			return;
		}

		if (this.take('do')) {
			this.statement();
			this.expect('while');
			this.parenthesizedExpression();
			this.take(';');
			return;
		}

		if (this.take('switch')) {
			this.parenthesizedExpression();
			this.expect('{');
			const previous = this.enter('block');
			while (!this.at('}')) {
				if (this.take('case')) {
					this.expression();
					this.expect(':');
				} else if (this.take('default')) {
					this.expect(':');
				} else {
					this.statement();
				}
			}

			this.expect('}');
			this.scope = previous;
			return;
		}

		if (this.take('try')) {
			this.block();
			let handler = false;
			if (this.take('catch')) {
				handler = true;
				const previous = this.enter('block');
				if (this.take('(')) {
					this.bindingPattern(false);
					if (this.take(':')) {
						this.type();
					}

					this.expect(')');
				}

				this.block();
				this.scope = previous;
			}

			if (this.take('finally')) {
				handler = true;
				this.block();
			}

			if (!handler) {
				this.fail('Expected catch or finally');
			}
			return;
		}

		if (this.at('return') || this.at('throw')) {
			const throws = this.next().text === 'throw';
			if (throws && this.token.lineBreak) {
				this.fail('Line break after throw');
			}

			if (!this.token.lineBreak && !this.at(';') && !this.at('}') && this.token.kind !== 'eof') {
				this.expression();
			}

			this.semicolon();
			return;
		}

		if (this.take('break') || this.take('continue')) {
			if (!this.token.lineBreak && this.token.kind === 'identifier') {
				this.name();
			}

			this.semicolon();
			return;
		}

		if (this.take('debugger')) {
			this.semicolon();
			return;
		}

		if (this.token.kind === 'identifier' && this.scanner.peek().text === ':') {
			this.name();
			this.expect(':');
			this.statement();
			return;
		}

		this.expression();
		this.semicolon();

		return undefined;
	}

	private block(kind: Scope['kind'] = 'block'): void {
		this.expect('{');
		const previous = this.enter(kind);
		while (!this.at('}')) {
			if (this.token.kind === 'eof') {
				this.fail('Unterminated block');
			}

			this.statement();
		}

		this.expect('}');
		this.scope = previous;
	}

	private exportBinding(token: Token, exported: boolean): void {
		const binding = this.scope.bindings.get(token.text)?.find(binding => binding.start === token.start);
		if (exported && binding) {
			this.publish(binding);
		}
	}

	private publish(binding: Binding): void {
		const target = binding.scope.namespace ?? binding.scope;
		if (binding.scope.namespace) {
			const bindings = target.bindings.get(binding.name) ?? [];
			if (!bindings.includes(binding)) {
				bindings.push(binding);
				target.bindings.set(binding.name, bindings);
			}
		}

		if (target.exports && !target.exports.some(entry => entry.binding === binding)) {
			target.exports.push({
				exported: binding.name,
				local: binding.name,
				binding
			});
		}
	}

	private namespaceDeclaration(exported: boolean, ambient: boolean): void {
		const previous = this.scope;
		const global = this.take('global');
		if (!global) {
			this.next();
		}

		let shared: Scope;
		const external = this.token.kind === 'string';
		if (global || this.token.kind === 'string') {
			const name = global ? 'global' : this.string().text;
			shared = this.source.ambientModules.get(name) ?? {
				kind: 'namespace',
				parent: previous,
				bindings: new Map(),
				exports: []
			};
			this.source.ambientModules.set(name, shared);
			ambient = true;
		} else {
			do {
				const token = this.name(true);
				const binding = this.bind(token, 3);
				this.exportBinding(token, exported || ambient);
				const owner = (exported || ambient) && this.scope.namespace ? this.scope.namespace : this.scope;
				const namespaces = owner.namespaces ??= new Map();
				shared = namespaces.get(token.text) ?? {
					kind: 'namespace',
					parent: this.scope.namespace ?? this.scope,
					bindings: new Map(),
					exports: []
				};
				namespaces.set(token.text, shared);
				binding.namespace = shared;
				this.scope = shared;
				exported = true;
			} while (this.take('.'));
		}

		if (this.take('{')) {
			this.scope = {
				kind: 'module',
				parent: shared,
				namespace: shared,
				bindings: new Map(),
				exports: shared.exports,
				ambient
			};
			while (!this.at('}')) {
				if (this.token.kind === 'eof') {
					this.fail('Unterminated namespace');
				}

				this.statement();
			}
			this.expect('}');
		} else {
			if (!external) {
				this.fail('Expected a namespace body');
			}

			this.semicolon();
		}

		this.scope = previous;
	}

	private exportStatement(top: boolean): void {
		this.expect('export');
		if (this.take('=')) {
			if (this.scope.namespace) {
				this.scope.namespace.exportEquals = true;
			} else if (this.scope === this.source.scope) {
				this.source.exportEquals = true;
			}
			this.expression();
			this.semicolon();
			return;
		}

		if (this.take('default')) {
			const entry: ExportEntry = {
				exported: 'default'
			};
			if (this.at('async') && this.scanner.peek().text === 'function') {
				this.next();
			}

			if (this.at('function')) {
				const fn = this.functionDeclaration(true, false, true);
				entry.binding = [...this.scope.bindings.values()].flat().find(binding => binding.function === fn) ?? {
					name:     'default',
					start:    fn.start,
					scope:    this.scope,
					meaning:  2,
					constant: true,
					function: fn,
				};
			} else if (this.at('class')) {
				this.classDeclaration(true, false, true);
			} else {
				const value = this.expression(2);
				if (value.reference && value.depth === 0) {
					entry.local = value.reference.name;
				}
				this.semicolon();
			}

			if (this.scope.exports) {
				this.scope.exports.push(entry);
			}
			return;
		}

		if (this.take('as')) {
			this.expect('namespace');
			this.name();
			this.semicolon();
			return;
		}

		const typeOnly = this.at('type') && ['{', '*'].includes(this.scanner.peek().text);
		if (typeOnly) {
			this.next();
		}

		const entries: ExportEntry[] = [];
		if (this.take('*')) {
			const exported = this.take('as') ? this.name().text : '*';
			this.expect('from');
			entries.push({
				exported,
				module:    this.string().text,
				imported:  '*',
				namespace: exported !== '*'
			});
		} else if (this.take('{')) {
			const references: Array<{ token: Token; typeOnly: boolean }> = [];
			while (!this.at('}')) {
				this.jsdoc(true);
				const inlineType = this.at('type') && !['as', ',', '}'].includes(this.scanner.peek().text);
				if (inlineType) {
					this.next();
				}

				const local    = this.token.kind === 'string' ? this.string() : this.name();
				const exported = this.take('as') ? (this.token.kind === 'string' ? this.string() : this.name()).text : local.text;
				entries.push({
					exported,
					local: local.text,
					scope: this.scope
				});
				references.push({
					token:    local,
					typeOnly: typeOnly || inlineType
				});
				if (!this.take(',')) {
					break;
				}
			}

			this.expect('}');
			if (this.take('from')) {
				const module = this.string().text;
				for (const entry of entries) {
					entry.module = module;
					entry.imported = entry.local;
					delete entry.local;
				}
			} else {
				for (const reference of references) {
					this.reference(reference.token, reference.typeOnly, 3);
				}
			}
		} else {
			this.statement(top, true);
			return;
		}

		if (this.scope.exports) {
			this.scope.exports.push(...entries);
		}

		this.importAttributes();
		this.semicolon();
	}

	private string(): Token {
		if (this.token.kind !== 'string') {
			this.fail('Expected a string literal');
		}

		return this.next();
	}

	private importAttributes(): TextNode | undefined {
		if (!this.at('with') && !this.at('assert')) {
			return undefined;
		}

		const start = this.next().start;
		this.expect('{');
		while (!this.at('}')) {
			if (this.token.kind === 'string') {
				this.string();
			} else {
				this.name();
			}

			this.expect(':');
			this.string();
			if (!this.take(',')) {
				break;
			}
		}

		this.expect('}');

		return new TextNode(this.source.text, start, this.end);
	}

	private importDeclaration(top: boolean, exported: boolean): ImportDeclaration | undefined {
		const fullStart = this.end;
		const start     = this.next().start;
		let clause: ImportClause | undefined;
		const bindings: Array<{ binding: Binding; imported: string }> = [];
		if (this.token.kind !== 'string') {
			const isTypeOnly = this.at('type') && !['from', '=', ','].includes(this.scanner.peek().text);
			if (isTypeOnly) {
				this.next();
			}

			const phaseModifier = this.at('defer') && this.scanner.peek().text === '*' ? this.next().text : undefined;
			clause = {
				isTypeOnly,
				phaseModifier
			};
			if (this.token.kind === 'identifier') {
				const token = this.name(true);
				clause.name = this.span(token);
				const binding = this.bind(token, 3);
				bindings.push({
					binding,
					imported: 'default'
				});
				if (this.take('=')) {
					if (this.at('require') && this.scanner.peek().text === '(') {
						this.next();
						this.expect('(');
						binding.import = {
							module: this.string().text,
							imported: '*'
						};
						this.expect(')');
					} else {
						const reference = this.reference(this.name(), false, 3);
						const members: string[] = [];
						while (this.take('.')) {
							const member = this.name();
							members.push(member.text);
							if (!reference.member) {
							reference.member = {
								name:      member.text,
								nameStart: member.start,
								start:     reference.start,
								end:       member.end,
								optional:  false,
								call:      false,
								jsx:       false,
								computed:  false
							};
							}
						}
						binding.alias = {
							reference,
							members
						};
					}
					this.exportBinding(token, exported);
					this.semicolon();
					return;
				}

				if (!this.at('from')) {
					this.expect(',');
				}
			}

			if (this.at('*')) {
				const token = this.next();
				this.expect('as');
				const name = this.name(true);
				clause.namedBindings = Object.assign(new TextNode(this.source.text, token.start, name.end), {
					kind: 'namespace' as const,
					name: this.span(name)
				});
				bindings.push({
					binding:  this.bind(name, 3),
					imported: '*'
				});
			} else if (this.at('{')) {
				const token = this.next();
				const elements: ImportSpecifier[] = [];
				while (!this.at('}')) {
					const inlineType = this.at('type') && !['as', ',', '}'].includes(this.scanner.peek().text);
					if (inlineType) {
						this.next();
					}

					const imported = (this.token as Token).kind === 'string' ? this.string() : this.name();
					const aliased  = this.take('as');
					const name     = aliased ? this.name(true) : imported;
					if (name.kind !== 'identifier' || invalidBindings.has(name.text)) {
						this.fail('Expected a local import binding');
					}

					elements.push({
						name:         this.span(name),
						propertyName: aliased ? this.span(imported) : undefined,
						isTypeOnly:   inlineType
					});
					bindings.push({
						binding:  this.bind(name, 3),
						imported: imported.text
					});
					if (!this.take(',')) {
						break;
					}
				}

				this.expect('}');
				clause.namedBindings = Object.assign(new TextNode(this.source.text, token.start, this.end), {
					kind: 'named' as const,
					elements
				});
			}

			if (!clause.name && !clause.namedBindings) {
				this.fail('Expected an import clause');
			}

			this.expect('from');
		}

		const module     = this.string();
		const attributes = this.importAttributes();
		this.semicolon();
		for (const { binding, imported } of bindings) {
			binding.import = {
				module: module.text,
				imported
			};
		}

		if (!top) {
			return undefined;
		}

		return Object.assign(new TextNode(this.source.text, start, this.end, fullStart), {
			kind:            'import' as const,
			importClause:    clause,
			moduleSpecifier: this.span(module),
			attributes,
		});
	}

	private variables(exported = false): void {
		this.take('await');
		const kind = this.next().text;
		if (this.token.kind === 'eof' || this.at(';')) {
			return;
		}

		do {
			this.jsdoc(true);
			const bindings = this.bindingPattern(kind === 'const' || kind === 'using', kind === 'var');
			this.take('!');
			if (this.take(':')) {
				this.type();
			}

			if (this.take('=')) {
				const value = this.expression(2);
				if (bindings.length === 1 && value.function) {
					bindings[0].function = value.function;
				}
			}

			if (exported) {
				for (const binding of bindings) {
					this.publish(binding);
				}
			}
		} while (this.take(','));
	}

	private bindingPattern(constant: boolean, hoist = false): Binding[] {
		const result: Binding[] = [];
		if (this.take('{')) {
			while (!this.at('}')) {
				if (this.take('...')) {
					result.push(...this.bindingPattern(constant, hoist));
				} else {
					const name = this.propertyName();
					if (this.take(':')) {
						result.push(...this.bindingPattern(constant, hoist));
					} else if (name?.kind === 'identifier') {
						result.push(this.bind(name, 2, constant, hoist));
					} else {
						this.fail('Expected a binding');
					}
				}

				if (this.take('=')) {
					this.expression(2);
				}

				if (!this.take(',')) {
					break;
				}
			}

			this.expect('}');
		} else if (this.take('[')) {
			while (!this.at(']')) {
				if (this.take(',')) {
					continue;
				}

				this.take('...');
				result.push(...this.bindingPattern(constant, hoist));
				if (this.take('=')) {
					this.expression(2);
				}

				if (!this.take(',')) {
					break;
				}
			}

			this.expect(']');
		} else {
			result.push(this.bind(this.name(true), 2, constant, hoist));
		}

		return result;
	}

	private decorators(): void {
		while (this.take('@')) {
			this.source.hasDecorators = true;
			this.expression(15);
		}
	}

	private parameters(): void {
		this.expect('(');
		while (!this.at(')')) {
			this.jsdoc(true);
			this.decorators();
			while (modifiers.has(this.token.text) && this.scanner.peek().kind === 'identifier') {
				this.next();
			}

			this.take('...');
			if (this.at('this')) {
				for (const fn of this.functions) {
					fn.dependent = true;
				}
			}

			this.bindingPattern(false);
			this.take('?');
			if (this.take(':')) {
				this.type();
			}

			if (this.take('=')) {
				this.expression(2);
			}

			if (!this.take(',')) {
				break;
			}
		}

		this.expect(')');
	}

	private functionTail(start: number, arrow = false, singleParameter?: Token): FunctionInfo {
		const previous = this.enter('function');
		const fn: FunctionInfo = {
			start,
			end:       start,
			body:      false,
			dependent: false
		};
		this.functions.push(fn);
		this.typeParameters();
		if (singleParameter) {
			this.bind(singleParameter, 2, false);
		} else {
			this.parameters();
		}

		if (this.take(':')) {
			this.type();
		}

		if (arrow) {
			this.expect('=>');
		}

		if (this.at('{')) {
			fn.body = true;
			this.block('function');
		} else if (arrow) {
			fn.body = true;
			this.expression(2);
		} else {
			this.semicolon();
		}

		fn.end = this.end;
		this.functions.pop();
		this.scope = previous;

		return fn;
	}

	private functionDeclaration(declaration: boolean, exported = false, anonymous = false): FunctionInfo {
		this.jsdoc(!declaration);
		const start = this.next().start;
		this.take('*');
		const name = this.token.kind === 'identifier' ? this.name(true) : undefined;
		if (declaration && !name && !anonymous) {
			this.fail('Expected a function name');
		}

		const previous = this.scope;
		if (!declaration) {
			this.enter('block');
		}

		const existing = name && this.scope.bindings.get(name.text)?.find(binding => binding.function);
		const binding = name ? existing || this.bind(name, 2) : undefined;
		if (name) {
			this.exportBinding(name, exported);
		}

		const fn = this.functionTail(start);
		if (binding && (fn.body || !binding.function)) {
			binding.function = fn;
		}

		this.scope = previous;

		return fn;
	}

	private classDeclaration(declaration: boolean, exported = false, anonymous = false): void {
		this.jsdoc();
		this.expect('class');
		const name = this.token.kind === 'identifier' && !['extends', 'implements'].includes(this.token.text) ? this.name(true) : undefined;
		if (declaration && !name && !anonymous) {
			this.fail('Expected a class name');
		}

		if (name && declaration) {
			this.bind(name, 3);
			this.exportBinding(name, exported);
		}

		const previous = this.enter('type');
		if (name && !declaration) {
			this.bind(name, 3);
		}

		this.typeParameters();
		if (this.take('extends')) {
			this.expression(11);
		}

		if (this.take('implements')) {
			do {
				this.type();
			} while (this.take(','));
		}

		this.expect('{');
		while (!this.at('}')) {
			if (this.take(';')) {
				continue;
			}

			this.decorators();
			if (this.at('static') && this.scanner.peek().text === '{') {
				this.next();
				this.block('static');
				continue;
			}

			while (modifiers.has(this.token.text) && !['(', '<', ':', '=', ';', '}', '?', '!'].includes(this.scanner.peek().text)) {
				this.next();
			}

			if (['get', 'set', 'async'].includes(this.token.text) && !['(', '<', ':', '=', ';', '}', '?', '!'].includes(this.scanner.peek().text)) {
				this.next();
			}

			const start = this.token.start;
			this.take('*');
			if (this.at('[') && this.indexSignatureAhead()) {
				this.typeMember();
				continue;
			}

			this.propertyName();
			this.take('?');
			this.take('!');
			if (this.at('(') || this.at('<')) {
				this.functionTail(start);
			} else {
				if (this.take(':')) {
					this.type();
				}

				if (this.take('=')) {
					this.expression(2);
				}

				this.semicolon();
			}
		}

		this.expect('}');
		this.scope = previous;
	}

	private propertyName(): Token | undefined {
		this.jsdoc();
		if (this.take('[')) {
			this.expression();
			this.expect(']');

			return undefined;
		}

		this.take('#');
		if (this.isLiteral()) {
			return this.next();
		}

		return this.name();
	}

	private parenthesizedExpression(): Expression {
		const starts = [this.token.start];
		this.expect('(');
		while (this.at('(') && !this.arrowAhead()) {
			this.jsdoc(true);
			starts.push(this.next().start);
		}

		let expression = this.expression();
		for (let index = starts.length - 1; index >= 0; index--) {
			this.expect(')');
			expression = {
				...expression,
				start: starts[index],
				end: this.end
			};
			if (index > 0) {
				expression = this.expressionTail(this.postfix(expression), 0);
			}
		}

		return expression;
	}

	private write(expression: Expression): void {
		// Match the compiler's conservative ancestor walk, including computed keys
		// and call arguments, while stopping at nested statement boundaries.
		for (let index = this.statementReferences.length - 1; index >= 0; index--) {
			const reference = this.statementReferences[index];
			if (reference.start < expression.start) {
				break;
			}

			reference.written = true;
		}
	}

	private expression(minimum = 0): Expression {
		return this.expressionTail(this.postfix(this.primary(minimum <= 2)), minimum);
	}

	private expressionTail(left: Expression, minimum: number): Expression {
		while (true) {
			if (this.at('?') && minimum <= 3) {
				this.next();
				this.expression(2);
				this.expect(':');
				this.expression(2);
				left = {
					start:   left.start,
					end:     this.end,
					depth:   0,
				};
				continue;
			}

			const shift    = this.token.kind === 'punctuation' ? /^(?:>>>=|>>=|<<=|>>>|>>|<<)/.exec(this.source.text.slice(this.token.start))?.[0] : undefined;
			const operator = shift ?? this.token.text;

			const precedence = this.token.kind === 'string' || this.token.kind === 'number' ? -1 : binaryPrecedence.get(operator) ?? -1;
			if (precedence < minimum || !this.allowIn && operator === 'in' || this.token.lineBreak && ['as', 'satisfies'].includes(operator)) {
				break;
			}

			if (shift) {
				this.resume(this.token.start + shift.length);
			} else {
				this.next();
			}

			if (operator === 'as' || operator === 'satisfies') {
				if (!this.take('const')) {
					this.type();
				}

				left.end = this.end;
				continue;
			}

			if (precedence === 2) {
				this.write(left);
				if (operator === '=' && left.reference && /\.[cm]?jsx?$/.test(this.source.fileName)) {
					const name = left.depth === 1 && left.reference.name === 'exports' ? left.reference.member?.name : left.commonJsExport;
					if (name) {
						this.source.exports.push({
							exported: name,
							commonJs: left.reference
						});
					}
				}
			}

			this.expression(precedence + Number(precedence !== 2 && operator !== '**'));
			left = {
				start:   left.start,
				end:     this.end,
				depth:   0,
			};
		}

		return left;
	}

	private primary(allowArrow = true): Expression {
		const token = this.token;
		const empty = (): Expression => ({
			start:   token.start,
			end:     this.end,
			depth:   0,
		});
		if (token.kind === 'string' || token.kind === 'number') {
			this.next();

			return empty();
		}
		if (allowArrow && this.at('async') && !this.scanner.peek().lineBreak && this.arrowAhead(true)) {
			this.jsdoc(true);
			this.next();
			const parameter = this.token.kind === 'identifier' ? this.name(true) : undefined;
			return {
				...empty(),
				function: this.functionTail(token.start, true, parameter),
				end:      this.end
			};
		}

		if (allowArrow && (this.at('(') || this.at('<')) && this.arrowAhead()) {
			this.jsdoc(true);
			return {
				...empty(),
				function: this.functionTail(token.start, true),
				end:      this.end
			};
		}

		if (allowArrow && this.token.kind === 'identifier' && this.scanner.peek().text === '=>') {
			this.jsdoc(true);
			const parameter = this.name(true);
			return {
				...empty(),
				function: this.functionTail(token.start, true, parameter),
				end:      this.end
			};
		}

		if (this.at('async') && this.scanner.peek().text === 'function') {
			this.jsdoc(true);
			this.next();
		}

		if (this.at('function')) {
			return {
				...empty(),
				function: this.functionDeclaration(false),
				end:      this.end
			};
		}

		if (this.at('class')) {
			this.classDeclaration(false);

			return empty();
		}

		if (['+', '-', '!', '~', 'typeof', 'void', 'delete', 'await', '++', '--'].includes(this.token.text)) {
			const operator = this.next().text;
			const operand  = this.expression(15);
			if (['delete', '++', '--'].includes(operator)) {
				this.write(operand);
			}

			return empty();
		}

		if (this.take('yield')) {
			this.take('*');
			if (!this.token.lineBreak && ![';', '}', ')', ']', ','].some(token => this.at(token)) && this.token.kind !== 'eof') {
				this.expression(2);
			}

			return empty();
		}

		if (this.take('new')) {
			if (this.take('.')) {
				this.name();
			} else {
				this.postfix(this.primary(false), true);
			}

			return empty();
		}

		if (this.at('/')) {
			this.regex();

			return empty();
		}

		if (this.at('`')) {
			this.template(false);

			return empty();
		}

		if (this.at('<')) {
			if (/\.(?:tsx|jsx|js|mjs|cjs)$/i.test(this.source.fileName)) {
				this.jsx();
			} else {
				this.next();
				this.type();
				this.expect('>');
				const operand = this.expression(15);

				return {
					...operand,
					start: token.start
				};
			}

			return empty();
		}

		if (this.at('(')) {
			this.jsdoc(true);
			const expression = this.parenthesizedExpression();

			return {
				...expression,
				start: token.start,
				end:   this.end
			};
		}

		if (this.take('[')) {
			while (!this.at(']')) {
				if (this.take(',')) {
					continue;
				}

				this.take('...');
				this.expression(2);
				if (!this.take(',')) {
					break;
				}
			}

			this.expect(']');

			return empty();
		}

		if (this.at('{')) {
			return this.object();
		}

		if (this.token.kind === 'string' || this.token.kind === 'number' || ['true', 'false', 'null'].includes(this.token.text)) {
			this.next();

			return empty();
		}

		if (this.take('import')) {
			if (!this.at('(') && !this.at('.')) {
				this.fail('Expected an import expression');
			}

			return empty();
		}

		this.take('#');
		if (this.token.kind === 'identifier' && !invalidBindings.has(this.token.text)) {
			const reference = this.reference(this.name());

			return {
				...empty(),
				reference,
			};
		}

		return this.fail('Expected an expression');
	}

	private postfix(expression: Expression, construct = false): Expression {
		while (true) {
			if (this.at('.') || this.at('?.')) {
				const optional = this.next().text === '?.';
				if (!this.at('(') && !this.at('[') && !this.at('<')) {
					const privateMember = this.take('#');
					const name          = this.name();
					if (expression.reference?.name === 'module' && expression.depth === 1 && expression.reference.member?.name === 'exports') {
						expression.commonJsExport = name.text;
					} else {
						delete expression.commonJsExport;
					}
					if (expression.reference && expression.depth === 0
						&& expression.start === expression.reference.start && expression.end === expression.reference.end) {
						expression.reference.member = {
							name:      name.text,
							nameStart: name.start,
							start:     expression.reference.start,
							end:       name.end,
							optional,
							call:      false,
							jsx:       false,
							computed:  privateMember
						};
					}

					expression.depth++;
					expression.end = this.end;
					continue;
				}

				if (expression.reference?.member) {
					expression.reference.member.optional ||= optional;
				}
			}

			if (this.take('[')) {
				this.expression();
				this.expect(']');
				if (expression.reference && expression.depth === 0) {
					expression.reference.member = {
						name:      '',
						nameStart: expression.start,
						start:     expression.start,
						end:       this.end,
						optional:  false,
						call:      false,
						jsx:       false,
						computed:  true
					};
				}

				expression.depth++;
				expression.end = this.end;
				continue;
			}

			if (this.at('<') && !this.token.lineBreak && this.typeArgumentsAhead()) {
				this.typeArguments();
				continue;
			}

			if (this.take('(')) {
				if (!construct && expression.reference?.member && expression.depth === 1) {
					expression.reference.member.call = true;
				}

				if (expression.reference?.name === 'eval' && expression.depth === 0) {
					this.source.hasEval = true;
				}

				while (!this.at(')')) {
					this.take('...');
					this.expression(2);
					if (!this.take(',')) {
						break;
					}
				}

				this.expect(')');
				expression = {
					start:   expression.start,
					end:     this.end,
					depth:   0,
				};
				if (construct) {
					break;
				}
				continue;
			}

			if (this.at('`')) {
				if (expression.reference?.member && expression.depth === 1) {
					expression.reference.member.call = true;
				}

				this.template(false, true);
				expression = {
					start:   expression.start,
					end:     this.end,
					depth:   0,
				};
				continue;
			}

			if (!this.token.lineBreak && this.take('!')) {
				expression.end = this.end;
				continue;
			}

			if (!this.token.lineBreak && (this.take('++') || this.take('--'))) {
				this.write(expression);
				expression.end = this.end;
			}
			break;
		}

		return expression;
	}

	private object(): Expression {
		const start = this.next().start;
		while (!this.at('}')) {
			if (this.take('...')) {
				this.expression(2);
			} else {
				if (['async', 'get', 'set'].includes(this.token.text) && !['(', ':', ',', '}', '='].includes(this.scanner.peek().text)) {
					this.next();
				}

				this.take('*');
				const memberStart = this.token.start;
				const name        = this.propertyName();
				if (this.take(':')) {
					this.expression(2);
				} else if (this.at('(') || this.at('<')) {
					this.functionTail(memberStart);
				} else if (name?.kind === 'identifier') {
					this.reference(name);
					if (this.take('=')) {
						this.expression(2);
					}
				} else {
					this.fail('Expected a property value');
				}
			}

			if (!this.take(',')) {
				break;
			}
		}

		this.expect('}');

		return {
			start,
			end:   this.end,
			depth: 0,
		};
	}

	private regex(): void {
		let cursor         = this.token.start + 1;
		let characterClass = false;
		let closed         = false;
		while (cursor < this.source.text.length) {
			const character = this.source.text[cursor++];
			if (character === '\\') {
				if (/[\r\n\u2028\u2029]/.test(this.source.text[cursor] ?? '')) {
					break;
				}
				cursor++;
			} else if (/[\r\n\u2028\u2029]/.test(character)) {
				break;
			} else if (character === '[') {
				characterClass = true;
			} else if (character === ']') {
				characterClass = false;
			} else if (character === '/' && !characterClass) {
				closed = true;
				break;
			}
		}

		if (!closed) {
			this.fail('Unterminated regular expression');
		}

		while (/[a-z]/i.test(this.source.text[cursor] ?? '')) {
			cursor++;
		}

		this.resume(cursor);
	}

	private resume(position: number): void {
		this.end = position;
		this.scanner.position = position;
		this.token = this.scanner.next();
	}

	private template(type: boolean, tagged = false): void {
		let cursor = this.token.end;
		while (cursor < this.source.text.length) {
			const character = this.source.text[cursor++];
			if (character === '\\') {
				cursor = tagged ? cursor + 1 : this.scanner.scanEscape(cursor);
			} else if (character === '`') {
				this.resume(cursor);
				return;
			} else if (character === '$' && this.source.text[cursor] === '{') {
				this.resume(cursor + 1);
				if (type) {
					this.type();
				} else {
					this.expression();
				}

				if (!this.at('}')) {
					this.fail('Expected a template closing brace');
				}

				cursor = this.token.end;
			}
		}

		this.fail('Unterminated template');
	}

	private jsxName(reference: boolean): string {
		const token = this.name();
		let name    = token.text;
		const root  = reference && (/^[A-Z_$]/.test(name) || this.at('.')) ? this.reference(token) : undefined;
		while (this.at('.') || this.at(':') || this.at('-')) {
			const separator = this.next().text;
			const member    = this.name();
			if (root && !root.member && separator === '.') {
				root.member = {
					name:      member.text,
					nameStart: member.start,
					start:     root.start,
					end:       member.end,
					optional:  false,
					call:      false,
					jsx:       true,
					computed:  false
				};
			}

			name += separator + member.text;
		}

		return name;
	}

	private jsx(nested = false): void {
		this.expect('<');
		this.source.hasJsx ||= this.token.kind === 'identifier' || this.at('>');
		const fragment = this.at('>');
		const name     = fragment ? '' : this.jsxName(true);
		if (this.at('<')) {
			this.typeArguments();
		}

		while (!this.at('>') && !this.at('/')) {
			if (this.take('{')) {
				this.expect('...');
				this.expression();
				this.expect('}');
			} else {
				this.jsxName(false);
				if (this.at('=')) {
					this.next(true);
					if (this.token.kind === 'string') {
						this.next();
					} else if (this.take('{')) {
						this.expression();
						this.expect('}');
					} else if (this.at('<')) {
						this.jsx();
					} else {
						this.fail('Expected a JSX attribute value');
					}
				}
			}
		}

		if (this.take('/')) {
			this.closeJsx(nested);
			return;
		}

		if (!this.at('>')) {
			this.fail('Expected a JSX opening tag');
		}

		let cursor = this.token.end;
		while (cursor < this.source.text.length) {
			const nextTag        = this.source.text.indexOf('<', cursor);
			const nextExpression = this.source.text.indexOf('{', cursor);
			const next           = nextTag < 0 ? nextExpression : nextExpression < 0 ? nextTag : Math.min(nextTag, nextExpression);
			if (/[}>]/.test(this.source.text.slice(cursor, next < 0 ? undefined : next))) {
				this.fail('JSX text contains an unescaped closing delimiter');
			}
			if (next < 0) {
				break;
			}

			this.resume(next);
			if (this.take('{')) {
				if (!this.at('}')) {
					this.take('...');
					this.expression();
				}

				if (!this.at('}')) {
					this.fail('Expected a JSX expression closing brace');
				}

				cursor = this.token.end;
			} else if (this.scanner.peek().text === '/') {
				this.expect('<');
				this.expect('/');
				const closing = fragment ? '' : this.jsxName(true);
				if (closing !== name) {
					this.fail('Mismatched JSX tags');
				}

				this.closeJsx(nested);
				return;
			} else {
				this.jsx(true);
				cursor = this.end;
			}
		}

		this.fail('Unterminated JSX element');
	}

	private closeJsx(nested: boolean): void {
		if (!this.at('>')) {
			this.fail('Expected a JSX closing bracket');
		}

		if (nested) {
			this.end = this.token.end;
		} else {
			this.next();
		}
	}

	private probe(kind: string, inspect: (probe: Parser) => boolean): boolean {
		const key    = `${this.token.start}:${kind}`;
		const cached = this.lookahead.results.get(key);
		if (cached !== undefined) {
			return cached;
		}

		this.lookahead.depth++;
		let result = false;
		try {
			result = inspect(new Parser(this.source.fileName, this.source.text, this.token.start, this.lookahead));
		} catch (error) {
			if (!(error instanceof SyntaxError) && !(error instanceof RangeError)) {
				throw error;
			}
		} finally {
			this.lookahead.depth--;
		}

		this.lookahead.results.set(key, result);

		return result;
	}

	private arrowAhead(async = false): boolean {
		return this.probe(async ? 'async-arrow' : 'arrow', probe => {
			if (async) {
				probe.next();
			}

			if (probe.token.kind === 'identifier') {
				probe.name(true);
			} else {
				if (probe.at('<') && /\.[jt]sx$/.test(this.source.fileName)) {
					const scanner = new Scanner(this.source.text);
					scanner.position = probe.token.end;
					if (scanner.next().text === 'const') {
						scanner.next();
					}

					if (![',', 'extends', '='].includes(scanner.next().text)) {
						return false;
					}
				}
				probe.typeParameters();
				probe.parameters();
				if (probe.take(':')) {
					probe.type();
				}
			}

			return probe.at('=>');
		});
	}

	private typeArgumentsAhead(): boolean {
		return this.probe('type-arguments', probe => {
			probe.typeArguments();
			const token = probe.token;

			return ['(', '.', '?.', '[', '`', '{', ';', ',', ')', ']', '}', '=', '!', 'implements'].includes(token.text)
				|| token.kind === 'eof' || token.lineBreak;
		});
	}

	private typeParameters(): void {
		if (!this.take('<')) {
			return;
		}

		do {
			if (this.at('>')) {
				break;
			}

			while (['const', 'in', 'out'].includes(this.token.text) && this.scanner.peek().kind === 'identifier') {
				this.next();
			}

			this.bind(this.name(true), 1);
			if (this.take('extends')) {
				this.type();
			}

			if (this.take('=')) {
				this.type();
			}
		} while (this.take(','));
		this.expect('>');
	}

	private typeArguments(): void {
		this.expect('<');
		do {
			if (this.at('>')) {
				break;
			}

			this.type();
		} while (this.take(','));
		this.expect('>');
	}

	private type(minimum = 0): void {
		this.take('|');
		this.take('&');
		this.typePrimary();
		while (!this.token.lineBreak && this.take('[')) {
			if (!this.at(']')) {
				this.type();
			}

			this.expect(']');
		}

		while (minimum <= 2 && (this.take('|') || this.take('&'))) {
			this.type(3);
		}

		if (minimum <= 1 && !this.token.lineBreak && this.take('extends')) {
			const previous = this.enter('type');
			this.type(2);
			this.expect('?');
			this.type();
			this.scope = previous;
			this.expect(':');
			this.type();
		}

	}

	private typePrimary(): void {
		if (this.isLiteral()) {
			this.next();
			return;
		}
		if (['keyof', 'readonly', 'unique'].includes(this.token.text)) {
			this.next();
			this.type(3);
			return;
		}

		if (this.take('infer')) {
			this.bind(this.name(true), 1);
			if (this.take('extends')) {
				this.type(2);
			}
			return;
		}

		if (this.take('asserts')) {
			this.reference(this.name(), true, 2);
			if (this.take('is')) {
				this.type();
			}
			return;
		}

		if (this.at('new') || this.at('abstract') && this.scanner.peek().text === 'new') {
			this.take('abstract');
			this.expect('new');
			this.functionType();
			return;
		}

		if (this.at('<') || this.at('(') && this.arrowAhead()) {
			this.functionType();
			return;
		}

		if (this.take('(')) {
			this.type();
			this.expect(')');
			return;
		}

		if (this.at('{')) {
			this.typeObject();
			return;
		}

		if (this.take('[')) {
			while (!this.at(']')) {
				this.take('...');
				if (this.token.kind === 'identifier' && this.tupleLabelAhead()) {
					this.name();
					this.take('?');
					this.expect(':');
				}

				this.type();
				this.take('?');
				if (!this.take(',')) {
					break;
				}
			}

			this.expect(']');
			return;
		}

		if (this.at('`')) {
			this.template(true);
			return;
		}

		this.take('-');
		if (this.isLiteral() || primitiveTypes.has(this.token.text) && this.scanner.peek().text !== 'is') {
			this.next();
			return;
		}

		const query = this.take('typeof');
		if (this.take('import')) {
			this.expect('(');
			this.string();
			if (this.take(',')) {
				this.expression(2);
			}

			this.expect(')');
			while (this.take('.')) {
				this.name();
			}
		} else {
			const reference = this.reference(this.name(), true, query ? 2 : 1);
			while (this.take('.')) {
				const name = this.name();
				if (!reference.member) {
					reference.member = {
						name:      name.text,
						nameStart: name.start,
						start:     reference.start,
						end:       name.end,
						optional:  false,
						call:      false,
						jsx:       false,
						computed:  false
					};
				}
			}
		}

		if (!this.token.lineBreak && this.at('<')) {
			this.typeArguments();
		}

		if (this.take('is')) {
			this.type();
		}
	}

	private tupleLabelAhead(): boolean {
		const scanner = new Scanner(this.source.text);
		scanner.position = this.token.end;
		const token = scanner.next();

		return token.text === ':' || token.text === '?' && scanner.next().text === ':';
	}

	private functionType(): void {
		const previous = this.enter('type');
		this.typeParameters();
		this.parameters();
		this.expect('=>');
		this.type();
		this.scope = previous;
	}

	private typeObject(): void {
		this.expect('{');
		while (!this.at('}')) {
			if (this.take(';') || this.take(',')) {
				continue;
			}

			this.typeMember();
		}

		this.expect('}');
	}

	private indexSignatureAhead(): boolean {
		const scanner = new Scanner(this.source.text);
		scanner.position = this.token.end;
		const name      = scanner.next();
		const separator = scanner.next();

		return name.kind === 'identifier' && [':', 'in'].includes(separator.text);
	}

	private typeMember(): void {
		this.jsdoc();
		const previous = this.enter('type');
		this.take('+');
		this.take('-');
		if (this.at('readonly') && ![':', '?', '('].includes(this.scanner.peek().text)) {
			this.next();
		}

		if (this.at('[') && this.indexSignatureAhead()) {
			this.next();
			const token  = this.name();
			const mapped = this.take('in');
			this.bind(token, mapped ? 1 : 2);
			if (!mapped) {
				this.expect(':');
			}

			this.type();
			if (this.take('as')) {
				this.type();
			}

			this.expect(']');
			this.take('+');
			this.take('-');
		} else if (!this.at('(') && !this.at('<')) {
			if (this.at('new') && ['(', '<'].includes(this.scanner.peek().text) || ['get', 'set'].includes(this.token.text) && !['(', '<', ':', '?', ';', ','].includes(this.scanner.peek().text)) {
				const modifier = this.next().text;
				if (modifier !== 'new') {
					this.propertyName();
				}
			} else {
				this.propertyName();
			}
		}

		this.take('?');
		this.typeParameters();
		if (this.at('(')) {
			this.parameters();
		}

		if (this.take(':')) {
			this.type();
		}

		if (!this.take(',') && !this.take(';') && !this.at('}') && !this.token.lineBreak) {
			this.fail('Expected a type member separator');
		}

		this.scope = previous;
	}
}

export function parseSource(fileName: string, text: string): SourceFile {
	return new Parser(fileName, text).parse();
}
