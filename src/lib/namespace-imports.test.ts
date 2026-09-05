import ts from 'typescript';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getNamespaceImportFixes } from './organizer';
import type { NamespaceImportFix } from './namespace-imports';

const filename = path.join(process.cwd(), '__namespace_fixtures__', 'main.ts');
const dependency = path.join(process.cwd(), '__namespace_fixtures__', 'utils.ts');
const defaultModule = 'export const answer = 42; export const format = (n: number) => String(n); export interface Model { id: number }';
function analyze(content: string, module = defaultModule) {
	const files = new Map([[filename, content], [dependency, module]]);
	return getNamespaceImportFixes(content, filename, {
		readFile: file => files.get(path.resolve(file)), fileExists: file => files.has(path.resolve(file)), directoryExists: () => true,
	});
}
function apply(content: string, fix: NamespaceImportFix): string {
	for (const edit of [...fix.edits].sort((a, b) => b.start - a.start)) { content = content.slice(0, edit.start) + edit.newText + content.slice(edit.end); }
	return content;
}

test('converts namespace values, types and verified receiver-independent calls', () => {
	const content = "import * as utils from './utils.js';\nconst answer = utils.answer;\nconst text = utils.format(answer);\nlet model: utils.Model;\n";
	const result = analyze(content);
	assert.equal(result.fixes.length, 1, JSON.stringify(result.skipped));
	const converted = apply(content, result.fixes[0]);
	assert.match(converted, /import \{ answer as utils_answer, format, Model \} from '\.\/utils.js';/);
	assert.match(converted, /const answer = utils_answer/);
	assert.match(converted, /format\(answer\)/);
	assert.match(converted, /let model: Model/);
	assert.equal(analyze(converted).fixes.length, 0);
});

test('avoids collisions in all scopes and preserves shadowed namespace references', () => {
	const content = "import * as utils from './utils.js';\nconst format = 0, utils_format = 1;\nfunction f(utils_format2: number) { return utils.format(1); }\nfunction g(utils: any) { return utils.format(2); }";
	const result = analyze(content);
	assert.equal(result.fixes.length, 1, JSON.stringify(result.skipped));
	const converted = apply(content, result.fixes[0]);
	assert.match(converted, /format as utils_format3/);
	assert.match(converted, /return utils_format3\(1\)/);
	assert.match(converted, /return utils.format\(2\)/);
});

test('preserves type-only imports, default bindings, comments and CRLF', () => {
	for (const clause of ['type * as utils', 'Default, * as utils']) {
		const content = `// header\r\nimport ${clause} from './utils.js'; // trailing\r\nlet value: utils.Model;\r\n`;
		const result = analyze(content);
		assert.equal(result.fixes.length, 1, JSON.stringify(result.skipped));
		const converted = apply(content, result.fixes[0]);
		assert.match(converted, clause.startsWith('type') ? /import type \{ Model \}/ : /import Default, \{ Model \}/);
		assert.ok(converted.startsWith('// header\r\n'));
		assert.ok(converted.includes('// trailing\r\n'));
		assert.ok(converted.endsWith('let value: Model;\r\n'));
	}
});

test('rejects dynamic access, object escapes, writes, optional access and default interop', () => {
	for (const use of [
		'utils["answer"]', 'consume(utils)', '({ utils })', 'export { utils };', 'Object.keys(utils)',
		'utils.answer = 1', 'utils.answer++', 'delete utils.answer', '[utils.answer] = [1]',
		'utils?.answer', 'utils.default', 'type T = typeof utils;', 'eval("utils")',
	]) {
		const result = analyze(`import * as utils from './utils.js';\n${use};`);
		assert.equal(result.fixes.length, 0, use);
		assert.equal(result.skipped.length, 1, use);
	}
});

test('rejects receiver-dependent calls, unavailable implementations and reassigned functions', () => {
	const content = "import * as utils from './utils.js';\nutils.format(1);";
	for (const module of [
		'export function format() { return this.answer; }',
		'export function format(n = this.answer) { return n; }',
		'export declare function format(n: number): string;',
		'export let format = (n: number) => String(n);',
		'export function format(n: number) { return String(n); } format = function() { return this.answer; };',
		'export function format(n: number) { return eval("this.answer"); }',
		'',
	]) {
		const result = analyze(content, module);
		assert.equal(result.fixes.length, 0, module);
		assert.match(result.skipped[0].reason, /receiver|resolved/);
	}
	for (const use of ['(utils.format)(1)', 'utils.format!(1)', 'utils.format`a`']) {
		assert.equal(analyze(`import * as utils from './utils.js';\n${use}`, 'export function format() { return this.answer; }').fixes.length, 0, use);
	}
});

test('honors protected imports, syntax errors, JSX factories and Vue limitations', () => {
	const content = "import * as utils from './utils.js';\nconst x = utils.answer;";
	for (const prefix of ['// import-authority-ignore-file\n', '// import-authority-pin\n', '// import-authority-off\n']) {
		assert.equal(analyze(prefix + content).fixes.length, 0);
	}
	assert.equal(analyze("import * as utils from './utils.js';\nconst = ;").fixes.length, 0);
	assert.equal(getNamespaceImportFixes(`<script>${content}</script>`, 'a.vue').fixes.length, 0);
	assert.equal(getNamespaceImportFixes("import * as React from 'react';\nlet x: React.Node; const el = <div />;", 'a.tsx').fixes.length, 0);
	assert.equal(analyze("import /* keep */ * as utils from './utils.js';\nutils.answer;").fixes.length, 0);
	assert.equal(analyze("import * as utils from './utils.js';\n/** @type {utils.Model} */ let model;\nutils.answer;").fixes.length, 0);
	assert.equal(analyze(content, 'const object = { answer: 42 }; export = object;').fixes.length, 0);
	const disabledUse = analyze("import * as utils from './utils.js';\n// import-authority-off\nconst x = utils.answer;\n// import-authority-on\n");
	assert.equal(disabledUse.fixes.length, 0);
	assert.match(disabledUse.skipped[0].reason, /disabled region/);
});

test('keeps receiver identity for nested member calls and provides aliases for keywords', () => {
	const content = "import * as utils from './utils.js';\nutils.object.method();\nconst value = utils.delete;";
	const result = analyze(content, 'const remove = 1; export { remove as delete }; export const object = { method() { return this; } };');
	assert.equal(result.fixes.length, 1, JSON.stringify(result.skipped));
	const converted = apply(content, result.fixes[0]);
	assert.match(converted, /object.method\(\)/);
	assert.match(converted, /delete as utils_delete/);
	assert.deepEqual(ts.transpileModule(converted, { compilerOptions: { module: ts.ModuleKind.ESNext }, reportDiagnostics: true }).diagnostics, []);
});
