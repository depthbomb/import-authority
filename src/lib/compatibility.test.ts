import ts from 'typescript';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as current from './organizer';
import { readProjectConfig } from './project-config';

const baseline = (require('../../scripts/compatibility-baseline.cjs') as { loadBaseline(): typeof current }).loadBaseline();
const root = path.resolve('__compatibility_fixtures__');
const filename = path.join(root, 'main.ts');

function compare(content: string, file = filename, options?: Partial<current.OrganizerOptions>): void {
	assert.deepEqual(current.organizeImportsWithReport(content, file, options), baseline.organizeImportsWithReport(content, file, options), content);
	assert.deepEqual(current.getImportFixes(content, file, options), baseline.getImportFixes(content, file, options), content);
	assert.equal(current.removeUnusedImportsByScan(content, file), baseline.removeUnusedImportsByScan(content, file), content);
	assert.equal(current.hasImportAuthorityDirectives(content, file), baseline.hasImportAuthorityDirectives(content, file), content);
}

function context(files: Record<string, string>) {
	const entries = new Map(Object.entries(files).map(([name, text]) => [path.resolve(root, name), text]));
	return {
		readFile: (file: string) => entries.get(path.resolve(file)),
		fileExists: (file: string) => entries.has(path.resolve(file)),
		directoryExists: (directory: string) => [...entries.keys()].some(file => file.startsWith(path.resolve(directory) + path.sep)),
	};
}

test('release compatibility: static block vars never shadow imports outside the block', () => {
	const content = "import { Model } from './lib';\nlet value: Model;\nfunction f() { class C { static { var Model = 1; } } return Model; }";
	compare(content);
	const organized = current.organizeImportsContent(content, filename);
	const compiled = ts.transpileModule(organized, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
	const model = class Model {};
	assert.equal(new Function('require', 'exports', compiled + '\nreturn f();')(() => ({ Model: model }), {}), model);
});

test('release compatibility: namespace declarations share exports but keep private locals separate', () => {
	for (const first of ['export const Model = 1;', 'const Model = 1;', 'export type Model = string;', 'export namespace Nested { export const value = 1; }']) {
		for (const second of ['console.log(Model);', 'let item: Model;', 'let item: typeof Model;']) {
			compare(`import { Model } from './lib';\nlet value: Model;\nnamespace N { ${first} }\nnamespace N { ${second} }`);
		}
	}
});

test('release compatibility: valid deep expressions are organized', () => {
	for (const depth of [100, 320, 600]) {
		compare(`import { Z } from 'z';\nimport { A } from 'a';\nconst value = ${'('.repeat(depth)}A${')'.repeat(depth)};`);
	}
});

test('release compatibility: generic constraints can contain conditional types', () => {
	for (const constraint of [
		'S extends "safe" ? keyof Model : string',
		'S extends Model ? (Model extends object ? keyof Model : never) : string',
		'S extends infer U extends Model ? U : never',
	]) {
		compare(`import { Model } from './lib';\ntype PickKey<S, Key extends ${constraint}, Other = Model> = Key;`);
	}
});

test('release compatibility: JSDoc prose and actual references remain distinct', () => {
	for (const comment of ['/** utils provide helpers. */', '/** @description utils provide helpers. */', '/** @type {utils.Model} */', '/** See {@link utils.answer}. */', '/** @param {utils.Model} value input */']) {
		const content = `import * as utils from './lib.js';\n${comment}\nconst answer = utils.answer;`;
		const host = context({ 'lib.ts': 'export const answer = 42; export interface Model {}' });
		assert.deepEqual(current.getNamespaceImportFixes(content, filename, host), baseline.getNamespaceImportFixes(content, filename, host), comment);
	}
});

test('release compatibility: Classic resolution and ambient re-exports remain available', () => {
	for (const fixture of [
		{ source: "import * as utils from 'lib';\nutils.answer;", files: { 'lib.ts': 'export const answer = 42;' }, compilerOptions: { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Classic } },
		{ source: "import * as utils from './lib.js';\nutils.answer;", files: { 'lib.ts': '/// <reference path="./virtual.d.ts" />\nexport { answer } from "virtual-module";', 'virtual.d.ts': 'declare module "virtual-module" { export const answer: number; }' } },
	] as Array<{ source: string; files: Record<string, string>; compilerOptions?: { module: number; moduleResolution: number } }>) {
		const host = { ...context(fixture.files), compilerOptions: fixture.compilerOptions };
		assert.deepEqual(current.getNamespaceImportFixes(fixture.source, filename, host), baseline.getNamespaceImportFixes(fixture.source, filename, host));
	}
});

test('release compatibility: multi-file exports and receiver safety', () => {
	const libraries = [
		'export const answer = 42; export function call() { return answer; }',
		'export const answer = 42; export function call() { return this.answer; }',
		'export const answer = 42; export const call = () => answer;',
		'export let answer = 42; export let call = () => answer; call = () => 0;',
		'export declare const answer: number; export declare function call(): number;',
		'export const answer = 42; export class call {}',
		'const answer = 42; function call() { return answer; } export { answer, call };',
		'export const answer = 42; export function call() { return (() => this.answer)(); }',
		'export const answer = 42; export function call() { function f() { return this.answer; } return answer; }',
	];
	const routes = [
		'export * from "./implementation";',
		'export { answer, call } from "./implementation";',
		'import { answer, call } from "./implementation"; export { answer, call };',
		'import * as original from "./implementation"; export import answer = original.answer; export import call = original.call;',
		'import original = require("./implementation"); import first = original.call; export import call = first; export import answer = original.answer;',
		'/// <reference path="./virtual.d.ts" />\nexport { answer, call } from "virtual";',
	];
	for (const library of libraries) {
		for (const route of routes) {
			for (const use of ['utils.answer;', 'utils.call();', 'new utils.call();', 'const fn = utils.call;', 'utils["answer"];', 'utils?.answer;', 'utils.answer = 3;']) {
				const content = `import * as utils from './lib';\n${use}`;
				const host = context({ 'lib.ts': route, 'implementation.ts': library, 'virtual.d.ts': `declare module "virtual" { ${library} }` });
				assert.deepEqual(current.getNamespaceImportFixes(content, filename, host), baseline.getNamespaceImportFixes(content, filename, host), `${library}\n${route}\n${use}`);
			}
		}
	}
});

test('release compatibility: local JSX options survive a missing extended config', () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'import-authority-config-parity-'));
	const configFile = path.join(directory, 'tsconfig.json');
	writeFileSync(configFile, '{"extends":"./missing","compilerOptions":{"jsxFactory":"h","paths":{"@app/*":["src/*"]}}}');
	const expected = ts.getParsedCommandLineOfConfigFile(configFile, {}, { ...ts.sys, readDirectory: () => [], onUnRecoverableConfigFileDiagnostic() {} })!;
	const actual = readProjectConfig(configFile)!;
	assert.equal(actual?.options.jsxFactory, expected.options.jsxFactory);
	assert.deepEqual(actual.options.paths, expected.options.paths);
	const content = "import { h } from 'renderer';\nlet factory: typeof h;\nconst view = <div />;";
	const organized = current.organizeImportsContent(content, 'main.tsx', { jsxFactory: actual.options.jsxFactory });
	assert.equal(organized, baseline.organizeImportsContent(content, 'main.tsx', { jsxFactory: expected.options.jsxFactory }));
	const compiled = ts.transpileModule(organized, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h' } }).outputText;
	assert.equal(new Function('require', 'exports', compiled + '\nreturn view;')(() => ({ h: () => 'rendered' }), {}), 'rendered');
});

test('release compatibility: generated scope combinations preserve every public organizer result', () => {
	const bodies = [
		'Model;', 'let value: Model;', 'let value: typeof Model;', 'const value = { Model };',
		'const value = () => Model;', 'type T<Model> = Model;', 'const value = class Model { field = Model; };',
		'const value = class C { static { var Model = 1; } field = Model; };',
		'function inner(Model: unknown) { return Model; }', 'function inner() { return Model; }',
		'for (const Model of []) { void Model; } Model;', 'try {} catch (Model) { void Model; } Model;',
		'const value = { [Model]: 1 };', 'const value = `${Model}`;', 'type T = { [K in keyof Model]: Model[K] };',
	];
	const wrappers = [
		(body: string) => body,
		(body: string) => `{ ${body} }`,
		(body: string) => `function outer() { ${body} }`,
		(body: string) => `function outer(Model: unknown) { ${body} }`,
		(body: string) => `namespace N { ${body} }`,
		(body: string) => `namespace N { export const Model = 1; } namespace N { ${body} }`,
		(body: string) => `class C { static { ${body} } }`,
		(body: string) => `class C { method() { ${body} } }`,
	];
	for (const body of bodies) {
		for (const wrap of wrappers) {
			compare(`import { Model, Unused } from './lib';\nimport { Z } from 'z';\nlet item: Model;\n${wrap(body)}`);
		}
	}
});

test('release compatibility: a newline ends a conditional type before an extends property', () => {
	for (const body of ['interface X { mixins?: Model[]\nextends?: Model }', 'type X = { value: Model\nextends: Model }', 'type X = Model\nextends Model ? string : number;']) {
		compare(`import { Model } from './lib';\n${body}`);
	}
});

test('release compatibility: settings, file kinds, line endings and directives', () => {
	const configurations: Array<Partial<current.OrganizerOptions>> = [
		{}, { convertTypeOnlyImports: false }, { placeTypeImportsLast: false },
		{ placeDefaultAndNamespaceImportsLast: false }, { duplicateImportPolicy: 'never' }, { duplicateImportPolicy: 'namedOnly' },
		{ groupImports: true, aliasPrefixes: ['@app'], sideEffectPlacement: 'bottom' },
		{ moduleSpecifierOrder: 'alpha', quoteStyle: 'double', semicolonPolicy: 'always' },
		{ moduleSpecifierOrder: 'length', quoteStyle: 'single', semicolonPolicy: 'never' },
		{ typeImportStyle: 'inline', namedImportsWrapThreshold: 35, alignFromKeyword: true, normalizeRelativePaths: true },
	];
	const imports = 'import { Zebra, Alpha } from "./lib/index";\nimport { Model, beta as renamed } from "./lib/index";\nimport Default from "@app/example";\nimport "setup";\nimport * as ns from "node:path";\n';
	for (const extension of ['ts', 'tsx', 'mts', 'cts', 'd.ts', 'js', 'jsx', 'mjs', 'cjs', 'vue']) {
		for (const newline of ['\n', '\r\n']) {
			for (const options of configurations) {
				for (const directive of ['', '// import-authority-ignore-file\n', '// import-authority-pin\n']) {
					let source = directive + imports + 'let value: Model;\nconsole.log(Zebra, Default, ns.basename("a"));\n';
					if (extension === 'vue') {
						source = `<template><Alpha /></template>\n<script setup lang="ts">\n${source}</script>\n`;
					}
					compare(source.replaceAll('\n', newline), `fixture.${extension}`, options);
				}
			}
		}
	}
});

test('release compatibility: JSDoc tags, links, names and prose', () => {
	const comments = [
		'utils helps.', '@description utils helps.', '@example utils.answer;',
		'@type {utils.Model}', '@type utils.Model', '@type {"utils"}',
		'@param {utils.Model} value description', '@param {string} utils description', '@param {string} [value=utils] description',
		'@returns {utils.Model}', '@returns utils.Model', '@typedef {Object} utils', '@property {utils.Model} value',
		'@template utils, T', '@template T, utils', '@template {utils.Model} T', '@template [T=utils.Model]',
		'@callback utils', '@see utils.answer', '@see {@link utils.answer}', '@throws {utils.Model}',
		'@extends {utils.Model}', '@implements {utils.Model}', '@satisfies {utils.Model}',
		'@import { Model } from "utils"', '@import * as utils from "lib"', '@import { utils } from "lib"',
		'See {@link utils.answer text}.', 'See {@linkplain utils.answer | text}.', '@utils prose',
	];
	const failures: string[] = [];
	for (const comment of comments) {
		for (const extension of ['ts', 'js']) {
			const source = `import * as utils from './lib.js';\n/** ${comment} */\nconst answer = utils.answer;`;
			const host = context({ 'lib.ts': 'export const answer = 42; export interface Model {}' });
			try {
				assert.deepEqual(current.getNamespaceImportFixes(source, path.join(root, `main.${extension}`), host), baseline.getNamespaceImportFixes(source, path.join(root, `main.${extension}`), host));
			} catch {
				failures.push(`${extension}: ${comment}`);
			}
		}
	}
	assert.deepEqual(failures, []);
});

test('release compatibility: JSDoc attaches to declarations and casts, not arbitrary expressions', () => {
	for (const body of [
		'/** @type {utils.Model} */\nutils.answer;',
		'utils.answer;\n/** @type {utils.Model} */',
		'utils.answer; /** @type {utils.Model} */\nconst x=1;',
		'const x = /** @type {utils.Model} */ utils.answer;',
		'const x = /** @type {utils.Model} */ (utils.answer);',
		'const x = (/** @type {utils.Model} */ (utils.answer));',
		'const x = [/** @type {utils.Model} */ utils.answer];',
		'const x = {/** @type {utils.Model} */ value: utils.answer};',
		'const x = {\n/** @type {utils.Model} */\nvalue: utils.answer};',
		'const x = /** @type {utils.Model} */ function(){ return utils.answer; };',
		'const x = /** @type {utils.Model} */ () => utils.answer;',
		'function f(/** @type {utils.Model} */ x) { return utils.answer; }',
		'function f</** @type {utils.Model} */ T>() { return utils.answer; }',
	]) {
		const source = `import * as utils from './lib';\n${body}`;
		const host = context({ 'lib.ts': 'export const answer = 42; export interface Model {}' });
		assert.deepEqual(current.getNamespaceImportFixes(source, filename, host), baseline.getNamespaceImportFixes(source, filename, host), body);
	}
});

test('compatibility exception: parameter initializers must retain imports used before entering the function body', () => {
	// The released analyzer binds the body declaration in the parameter initializer.
	// Preserve the runtime behavior of the input, even though that corrects its output.
	const source = "import { Model } from './lib';\nlet value: Model;\nfunction f(x = Model) { function Model() {} return x; }";
	const original = baseline.organizeImportsContent(source, filename);
	const fixed = current.organizeImportsContent(source, filename);
	assert.match(original, /import type/);
	assert.doesNotMatch(fixed, /import type/);
	const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true } }).outputText.replace(/import \{ Model \} from '\.\/lib';/, 'const { Model } = require("./lib");').replace(/export \{\};/, '');
	const model = class Model {};
	assert.throws(() => new Function('require', 'exports', compile(original) + '\nreturn f();')(() => ({ Model: model }), {}), ReferenceError);
	assert.equal(new Function('require', 'exports', compile(fixed) + '\nreturn f();')(() => ({ Model: model }), {}), model);
});

test('release compatibility: incremental typing preserves diagnostics and edits on incomplete files', () => {
	for (const body of [
		'function f(value: Model) { return value; }',
		'class C { static { var Model = 1; } method() { return Model; } }',
		'const value = (Model?.member ?? Model) as Model;',
		'type T<K> = K extends Model ? keyof Model : never;',
		'const view = <Model value={Model}><Model /></Model>;',
		'const value = `text ${Model}`;',
		'namespace N { export const Model = 1; } namespace N { Model; }',
	]) {
		for (let length = 0; length <= body.length; length++) {
			compare(`import { Model } from './lib';\nimport { Z } from 'z';\n${body.slice(0, length)}`, 'typing.tsx');
		}
	}
});
