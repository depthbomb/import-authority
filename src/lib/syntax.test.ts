import ts from 'typescript';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, resolveReference } from './syntax';
import { organizeImportsContent } from './organizer';

const imports = "import { Model, Other, React, run, h } from 'pkg';\n";
const syntaxCases = [
	'let value: Model; run(value);',
	'type T = typeof Model; const c = typeof Other;',
	'function f(Model: number) { return Model + 1; } let m: Model;',
	'function f<Model>(x: Model): Model { return x; }',
	'const f = function Model() { return Model; }; let m: Model;',
	'const f = (Model: number) => Model; let m: Model;',
	'const f = async <T extends Model | Other>(x: T): Promise<T> => x;',
	'function f(x = Model) { var Model; return Model; } let m: Model;',
	'function f({ x: Model = Other }: {x?: number}) { return Model; }',
	'function f([Model, ...rest]: number[]) { return Model; } let m: Model;',
	'{ let Model: number; run(Model); } let m: Model;',
	'for (let Model of Other) { run(Model); } let m: Model;',
	'for (var Model in Other) { run(Model); }',
	'try { run(); } catch (Model) { run(Model); } let m: Model;',
	'class Child extends Model implements Other { field!: Other; method(x: Model): Other { return run(x); } }',
	'class Child<T extends Model> { private field?: T; static { run(Other); } get value(): T { return this.field!; } }',
	'const C = class Model { method() { return Model; } }; let m: Model;',
	'type T = { Model: Other; method(Model: number): Other; [run()]: Model };',
	'type T<Model> = { [K in keyof Model as `get${K & string}`]?: Model[K] };',
	'type T = { [Model in keyof Other]: Model }; let value: Model;',
	'type T = { [Model in keyof Model]: Model };',
	'type T<X> = X extends infer Model ? Model : Other;',
	'type T<X> = X extends { x: infer Model extends Other } ? Model : Model;',
	'type T = [Model?, Other?, ...Model[]];',
	'type T = [model?: Model, other?: Other];',
	'type T = (...args: Model[]) => Other;',
	'type T = abstract new <X extends Model>(x: X) => Other;',
	'function test(x: unknown): x is Model { return x instanceof Other; }',
	'function test(symbol: unknown): symbol is Model { return true; }',
	'function check(x: unknown): asserts x is Model { run(); }',
	'export { Model }; export type { Other };',
	'export { type Model as Public, Other as Value };',
	'export { Model } from "other"; let m: Model;',
	'export type * from "other"; let m: Model;',
	'export const value: Model = Other;',
	'const obj = { Model, [Other]: run(), ModelKey: Other };',
	'const obj = { get value(): Model { return Other; }, async run(x: Model) { return x; } };',
	'const { Model: local } = Other; let m: Model;',
	'const view = <Model value={Other} />;',
	'const view = <><Model>plain text and <Other /></Model></>;',
	'const view = <Model>it\'s text "and quotes" {Other}</Model>;',
	'const view = <Model><Other />it\'s still text</Model>;',
	'const view = <Model><Other />\'dangling quote</Model>;',
	'const view = <Model value="line\nline" />;',
	'const view = <Model<number> value={Other} />;',
	'const view = <div data-name="Model" value={Other} />;',
	'const view = <div>{`hello ${Model.name}`}</div>;',
	'const value = `literal import { Fake } from "fake"; ${Model} ${`nested ${Other}`}`;',
	'type T = `prefix${Model & string}${Other & string}`;',
	'const pattern = /import \{Model\} from "pkg"/g; let m: Model;',
	'if (run()) /Model/.test(Other); let m: Model;',
	'const ratio = Model / Other / 2;',
	'const fn = () => /Model/; let m: Model;',
	'const x = Model < Other && !/[\s=/>]/.test("x");',
	'let x = 1; x <<= 1; x >>= 1; x >>>= 1; run(Model);',
	'const x = new Map<Model, (...args: Other[]) => Model>();',
	'const x = new Map<Model, { value: Other; optional?: Model }>();',
	'const x = run<Model | Other>();',
	'const x = (run as Model & Other)!;',
	'const x = run satisfies Model | Other;',
	'function f<T extends Model | Other = Model>(value: T) { return value; }',
	'type T<X extends Model=Other>=X;',
	'interface I extends Model, Other { set(x: Model): Other; get(): Model; new (x: Model): Other; }',
	'namespace N { export const value: Model = Other; }',
	'export enum E { A = Model.value, B = Other.value }',
	'const f = () => { return "}" + Model + "${"; };',
	'if (run()) { let value: Model; } else { run(Other); }',
	'do { run(Model); } while (Other);',
	'switch (Other) { case Model: run(); break; default: break; }',
	'label: for (;;) { if (Model) break label; continue label; }',
	'const value = import("other"); type T = import("other").Model;',
	'type T = typeof import("other", { with: { "resolution-mode": "import" } }).Model;',
	'const value = import.meta.url; let m: Model;',
	'await using value = run(); let m: Model;',
	'const values = [0xDE_AD, 0xB_EE, 0xBE_EFn, 0b10_01n, 0o1_23, 1_234.5_6e7_8]; let m: Model;',
	'const text = run`\\xZZ`; let m: Model;',
	'const λ = Model; const Ελληνικά = Other; const 𝒳 = λ; run(𝒳, Ελληνικά);',
];

function compilerReferences(text: string): Map<string, { type: boolean; value: boolean }> {
	const source = ts.createSourceFile('fixture.tsx', text, ts.ScriptTarget.Latest, true);
	assert.deepEqual((source as ts.SourceFile & { parseDiagnostics: unknown[] }).parseDiagnostics, [], text);
	const host: ts.CompilerHost = {
		getSourceFile: file => file === source.fileName ? source : undefined,
		getDefaultLibFileName: () => '', writeFile() {}, getCurrentDirectory: () => '',
		getCanonicalFileName: file => file, useCaseSensitiveFileNames: () => true,
		getNewLine: () => '\n', fileExists: file => file === source.fileName, readFile: () => undefined,
	};
	const checker = ts.createProgram([source.fileName], { noResolve: true, noLib: true, target: ts.ScriptTarget.Latest }, host).getTypeChecker();
	const symbols = new Map<ts.Symbol, string>();
	for (const statement of source.statements.filter(ts.isImportDeclaration)) {
		const named = statement.importClause?.namedBindings;
		if (named && ts.isNamedImports(named)) {
			for (const element of named.elements) {
				const symbol = checker.getSymbolAtLocation(element.name);
				if (symbol) {
					symbols.set(symbol, element.name.text);
				}
			}
		}
	}

	const result = new Map<string, { type: boolean; value: boolean }>();
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			return;
		}

		if (ts.isIdentifier(node)) {
			const symbol = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent)
				: ts.isExportSpecifier(node.parent) ? checker.getExportSpecifierLocalTargetSymbol(node.parent) : checker.getSymbolAtLocation(node);
			const name = symbol && symbols.get(symbol);
			if (name) {
				let target: ts.Node = node;
				while (ts.isQualifiedName(target.parent) || ts.isPropertyAccessExpression(target.parent)) {
					target = target.parent;
				}

				const typeOnly = ts.isExportSpecifier(node.parent)
					? node.parent.isTypeOnly || node.parent.parent.parent.isTypeOnly
					: ts.isTypeQueryNode(target.parent) || ts.isPartOfTypeNode(target);
				const usage = result.get(name) ?? { type: false, value: false };
				usage.type ||= typeOnly;
				usage.value ||= !typeOnly;
				result.set(name, usage);
			}
		}

		ts.forEachChild(node, visit);
	};
	visit(source);

	return result;
}

test('custom syntax and local references agree with the compiler on language constructs', () => {
	const failures: string[] = [];
	for (const code of syntaxCases) {
		try {
			const text = imports + code;
			const source = parseSource('fixture.tsx', text);
			assert.deepEqual(source.parseDiagnostics, [], code);
			const actual = new Map<string, { type: boolean; value: boolean }>();
			for (const reference of source.references) {
				const binding = resolveReference(reference);
				if (binding?.import) {
					const usage = actual.get(binding.name) ?? { type: false, value: false };
					usage.type ||= reference.typeOnly;
					usage.value ||= !reference.typeOnly;
					actual.set(binding.name, usage);
				}
			}

			assert.deepEqual(actual, compilerReferences(text), code);
			const organized = organizeImportsContent(text, 'fixture.tsx');
			assert.equal(organizeImportsContent(organized, 'fixture.tsx'), organized, code);
		} catch (error) {
			failures.push(String(error));
		}
	}
	assert.deepEqual(failures, []);
});

test('malformed files remain unchanged', () => {
	for (const code of [
		'const = 1;', 'const x = ;', 'const x: = 1;', 'function f( {', 'const x = "unterminated',
		'const x = `unterminated', 'const x = `a${Model`;', '/* unterminated',
		'const x = /[unterminated/', 'const x = [1, 2;', 'const x = { a: };',
		'function () {}', 'class {}', 'if () {}', 'try {}', 'throw\nModel;',
		'type X = ;', 'type X<T = > = T;', 'const view = <Model></Other>;',
		'const view = <Model value=>;', 'const x = "\\xzz";', 'const \\q = 1;',
		'const x = 1__0;', 'const x = 0x_1;', 'const x = 1_e2;', 'const x = 1.2n;',
		'const x = 1_000_;', 'const x = 1e_2;', 'const x = 0b2;',
		'const x = 07;', 'const x = "\\141";', 'const x = `\\xZZ`;',
		'const x = /\\\n/;', 'const el = <C prop{x} />;', 'const el = <C>></C>;',
		'const f = <T>(x: T): T => x;', 'const x = 1 + x => x;',
	]) {
		const text = imports + code;
		assert.ok(parseSource('fixture.tsx', text).parseDiagnostics.length, code);
		assert.equal(organizeImportsContent(text, 'fixture.tsx'), text, code);
	}
});

test('nested arrow initializers share lookahead and deep parentheses do not exhaust the stack', () => {
	let expression = 'Model';
	for (let depth = 0; depth < 30; depth++) {
		expression = `(x${depth} = ${expression}) => x${depth}`;
	}
	const text = `${imports}const value = ${expression};`;
	assert.deepEqual(parseSource('fixture.ts', text).parseDiagnostics, []);
	assert.doesNotMatch(organizeImportsContent(text), /import type.*Model/);
	const deep = `${imports}const value = ${'('.repeat(1000)}Model${')'.repeat(1000)};`;
	assert.deepEqual(parseSource('fixture.ts', deep).parseDiagnostics, []);
	assert.doesNotMatch(organizeImportsContent(deep), /import type.*Model/);
});

test('token mutations rejected by the compiler never reach import transformations', () => {
	for (const code of [
		'const x = 1;', 'function f(x: Model) { return x; }',
		'class C extends Model { value: Other = x; method(y: Model) { return y; } }',
		'type T<X> = X extends Model ? Other : C;', 'const f = <T,>(x: T): T => x;',
		'let { a: b = x } = obj;', 'for (let i = 0; i < 4; i++) { run(i); }',
		'if (x) { run(); } else { run(); }', 'const el = <Model prop={x}><Other /></Model>;',
		'const x = `abc${Model}`;', 'const x = /foo[ab]/g;',
	]) {
		for (let index = 0; index < code.length; index++) {
			for (const replacement of ['', '?']) {
				const text = imports + code.slice(0, index) + replacement + code.slice(index + Number(replacement === ''));
				const compiler = ts.createSourceFile('fixture.tsx', text, ts.ScriptTarget.Latest, true) as ts.SourceFile & { parseDiagnostics: unknown[] };
				if (compiler.parseDiagnostics.length) {
					assert.ok(parseSource('fixture.tsx', text).parseDiagnostics.length, text);
					assert.equal(organizeImportsContent(text, 'fixture.tsx'), text);
				}
			}
		}
	}
});

test('parameter initializers preserve runtime imports hidden by declarations in the function body', () => {
	for (const declaration of ['var Model;', 'function Model() {}', 'let Model;', 'class Model {}']) {
		const source = `import { Model } from 'pkg';\nlet value: Model;\nfunction f(x = Model) { ${declaration} return x; }`;
		assert.doesNotMatch(organizeImportsContent(source), /import type/);
	}
});

test('type assertions, Unicode escapes, comments, and regex literals preserve import boundaries', () => {
	for (const code of [
		"import { M\\u006fdel, Other } from 'pkg';\nconst value = <Model>Other;",
		"import { Model, Other } from 'pkg';\nconst view = <Model attr={Other} />;",
		"import { Model, Other } from 'pkg';\nif (Other) /import Model from 'fake'/.test(Model);",
		"#!/usr/bin/env node\nimport { Model, Other } from 'pkg';\nrun(Model, Other);",
	]) {
		const filename = code.includes('<Model attr') ? 'fixture.tsx' : 'fixture.ts';
		const source = parseSource(filename, code);
		assert.deepEqual(source.parseDiagnostics, [], code);
		assert.equal(source.statements.filter(statement => statement.kind === 'import').length, 1);
	}
});
