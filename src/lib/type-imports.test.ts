import ts from 'typescript';
import test from 'node:test';
import assert from 'node:assert/strict';
import { organizeImportsContent, organizeImportsWithReport } from './organizer';

test('converts type-only uses by default before sorting and merging', () => {
	const content = "import { Model, run, Unused } from 'pkg';\nimport type { Other } from 'pkg';\nlet value: Model;\nrun(value);\n";
	const report  = organizeImportsWithReport(content);
	assert.match(report.content, /import \{ run, Unused \} from 'pkg';/);
	assert.match(report.content, /import type \{ Model, Other \} from 'pkg';/);
	assert.equal(report.converted, 1);
	assert.equal(report.merged, 1);
	assert.equal(organizeImportsContent(report.content), report.content);
	assert.doesNotMatch(organizeImportsContent(content, 'a.ts', {
		convertTypeOnlyImports: false
	}), /import type \{ Model/);
});

test('converts default, namespace, aliased and string-named bindings into legal declarations', () => {
	for (const content of [
		"import Default, { Named as Local } from 'pkg';\nlet a: Default; let b: Local;",
		"import Default, * as ns from 'pkg';\nlet a: Default; let b: ns.Named;",
		"import { 'a-b' as Local } from 'pkg';\nlet a: Local;",
	]) {
		const report = organizeImportsWithReport(content);
		assert.ok(report.converted > 0);
		assert.match(report.content, /import type/);

		const diagnostics = ts.transpileModule(report.content, {
			compilerOptions:   {
				module:               ts.ModuleKind.ESNext,
				verbatimModuleSyntax: true
			},
			reportDiagnostics: true,
		}).diagnostics ?? [];
		assert.deepEqual(diagnostics, []);
		assert.equal(organizeImportsContent(report.content), report.content);
	}
});

test('scope-aware usage preserves runtime references, shorthand exports and class extends', () => {
	for (const usage of ['new Model();', 'const a = { Model };', 'export { Model };', 'class A extends Model {}', 'const a = typeof Model;', 'const a = Model.x;']) {
		const content = `import { Model } from 'pkg';\nlet a: Model;\n${usage}`;
		assert.equal(organizeImportsWithReport(content).converted, 0, usage);
	}

	const shadowed = "import { Model } from 'pkg';\nlet a: Model;\nfunction f(Model: number) { return Model + 1; }";
	assert.equal(organizeImportsWithReport(shadowed).converted, 1);

	const onlyShadowed = "import { Model } from 'pkg';\nfunction f<Model>(a: Model) {}";
	assert.equal(organizeImportsWithReport(onlyShadowed).converted, 0);
});

test('recognizes type queries, interface inheritance, implements and explicit type exports', () => {
	for (const usage of ['type A = typeof Model;', 'interface A extends Model {}', 'class A implements Model {}', 'export type { Model };', 'export { type Model as Public };']) {
		assert.equal(organizeImportsWithReport(`import { Model } from 'pkg';\n${usage}`).converted, 1, usage);
	}
});

test('preserves runtime JSX factories while converting unrelated TSX types', () => {
	const content = "import React, { Model } from 'pkg';\nlet a: React.Component; let b: Model;\nconst view = <div />;";
	const report  = organizeImportsWithReport(content, 'a.tsx');
	assert.equal(report.converted, 1);
	assert.match(report.content, /import React from 'pkg'/);
	assert.match(report.content, /import type \{ Model \}/);

	const custom = "import { h, Frag, Model } from 'pkg';\nlet a: typeof h; let b: typeof Frag; let c: Model;\nconst view = <><div /></>;";
	assert.equal(organizeImportsWithReport(custom, 'a.tsx', {
		jsxFactory:         'h',
		jsxFragmentFactory: 'Frag'
	}).converted, 1);
	assert.equal(organizeImportsWithReport(`/** @jsx h @jsxFrag Frag */\n${custom}`, 'a.tsx').converted, 1);
});

test('preserves protected declarations, decorators, comments, attributes and non-TypeScript sources', () => {
	for (const prefix of ['// import-authority-pin\n', '// import-authority-ignore-file\n', '// import-authority-off\n']) {
		assert.equal(organizeImportsWithReport(`${prefix}import { Model } from 'pkg';\nlet a: Model;`).converted, 0);
	}

	for (const content of [
		"import { Model } from 'pkg';\n@decorator class A { property: Model; }",
		"import { Model } from 'pkg';\nlet a: Model; eval('Model');",
		"import { /* retain */ Model } from 'pkg';\nlet a: Model;",
		"import Model from 'pkg' with { type: 'json' };\nlet a: typeof Model;",
	]) {
		assert.equal(organizeImportsWithReport(content).converted, 0);
	}

	assert.equal(organizeImportsWithReport("import { Model } from 'pkg';\n/** @type {Model} */ let a;", 'a.js').converted, 0);
	assert.equal(organizeImportsWithReport('<script setup lang="ts">import { Model } from "pkg"; let a: Model;</script><template><Model /></template>', 'a.vue').converted, 0);
});

test('respects inline style, preserves comments and keeps explicit side-effect imports', () => {
	const content = "// header\nimport { Model, run } from 'pkg'; // trailing\nlet a: Model; run();\n";
	const inline = organizeImportsWithReport(content, 'a.ts', {
		typeImportStyle: 'inline'
	});
	assert.equal(inline.converted, 1);
	assert.match(inline.content, /import \{ run, type Model \}/);
	assert.equal(inline.content.match(/\/\/ header/g)?.length, 1);
	assert.equal(inline.content.match(/\/\/ trailing/g)?.length, 1);

	const bare = organizeImportsContent("import 'pkg';\nimport { Model } from 'pkg';\nlet a: Model;\n");
	assert.match(bare, /import 'pkg';/);
	assert.match(bare, /import type \{ Model \}/);
	assert.equal(organizeImportsContent(bare), bare);
});
