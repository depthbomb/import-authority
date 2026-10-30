import ts from 'typescript';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleResolver } from './module-resolver';
import { parseSource } from './syntax';
import type { CompilerOptions } from './project-config';
import { getNamespaceImportFixes } from './organizer';

const root = path.resolve('__resolution_fixtures__');
type Fixture = {
	name: string;
	specifier: string;
	files: Record<string, string>;
	options?: CompilerOptions;
	entry?: string;
};

const cases: Fixture[] = [
	{ name: 'JavaScript extension substitution', specifier: './lib.js', files: { 'lib.ts': 'export const answer = 1;' } },
	{ name: 'ESM extension substitution', specifier: './lib.mjs', files: { 'lib.d.mts': 'export declare const answer: number;' } },
	{ name: 'CommonJS extension substitution', specifier: './lib.cjs', files: { 'lib.cts': 'export const answer = 1;' } },
	{ name: 'directory index', specifier: './lib', files: { 'lib/index.ts': '' } },
	{ name: 'relative package types', specifier: './lib', files: { 'lib/package.json': '{"types":"types.d.ts"}', 'lib/types.d.ts': '' } },
	{ name: 'module suffixes', specifier: './lib.js', options: { moduleSuffixes: ['.native', ''] }, files: { 'lib.native.ts': '', 'lib.ts': '' } },
	{ name: 'declaration module suffixes', specifier: './lib.js', options: { moduleSuffixes: ['.native', ''] }, files: { 'lib.native.d.ts': '', 'lib.d.ts': '' } },
	{ name: 'longest path alias', specifier: '@app/special/lib', options: { pathsBasePath: root, paths: { '@app/*': ['wrong/*'], '@app/special/*': ['lib/*'] } }, files: { 'lib/lib.ts': '', 'wrong/special/lib.ts': '' } },
	{ name: 'path fallback', specifier: '@app/lib', options: { baseUrl: root, paths: { '@app/*': ['missing/*', 'lib/*'] } }, files: { 'lib/lib.ts': '' } },
	{ name: 'base URL', specifier: 'lib', options: { baseUrl: root }, files: { 'lib.ts': '' } },
	{ name: 'rootDirs', specifier: './view', entry: 'src/main.ts', options: { rootDirs: [path.join(root, 'src'), path.join(root, 'generated')] }, files: { 'generated/view.ts': '' } },
	{ name: 'package types', specifier: 'pkg', files: { 'node_modules/pkg/package.json': '{"types":"types.d.ts","main":"index.js"}', 'node_modules/pkg/types.d.ts': '', 'node_modules/pkg/index.js': '' } },
	{ name: 'package typings', specifier: 'pkg', files: { 'node_modules/pkg/package.json': '{"typings":"types.d.ts"}', 'node_modules/pkg/types.d.ts': '' } },
	{ name: 'DefinitelyTyped before JS', specifier: 'pkg', files: { 'node_modules/pkg/index.js': '', 'node_modules/@types/pkg/index.d.ts': '' } },
	{ name: 'scoped DefinitelyTyped', specifier: '@scope/pkg', files: { 'node_modules/@types/scope__pkg/index.d.ts': '' } },
	{ name: 'exports types condition', specifier: 'pkg', files: { 'node_modules/pkg/package.json': '{"exports":{".":{"types":"./types.d.ts","default":"./index.js"}}}', 'node_modules/pkg/types.d.ts': '', 'node_modules/pkg/index.js': '' } },
	{ name: 'exports missing condition fallback', specifier: 'pkg', files: { 'node_modules/pkg/package.json': '{"exports":{"types":"./missing.d.ts","default":"./index.js"}}', 'node_modules/pkg/index.ts': '' } },
	{ name: 'exports wildcard', specifier: 'pkg/feature/a', files: { 'node_modules/pkg/package.json': '{"exports":{"./feature/*":"./src/*.js"}}', 'node_modules/pkg/src/a.ts': '' } },
	{ name: 'exports block private paths', specifier: 'pkg/private', files: { 'node_modules/pkg/package.json': '{"exports":{".":"./index.js"}}', 'node_modules/pkg/private.ts': '' } },
	{ name: 'exports null exclusion', specifier: 'pkg/private/a', files: { 'node_modules/pkg/package.json': '{"exports":{"./*":"./src/*.js","./private/*":null}}', 'node_modules/pkg/src/private/a.ts': '' } },
	{ name: 'Node10 ignores exports', specifier: 'pkg', options: { moduleResolution: 'Node10' }, files: { 'node_modules/pkg/package.json': '{"exports":"./hidden.js","types":"types.d.ts"}', 'node_modules/pkg/hidden.ts': '', 'node_modules/pkg/types.d.ts': '' } },
	{ name: 'bundler import condition', specifier: 'pkg', options: { moduleResolution: 'Bundler', module: 'Preserve' }, files: { 'node_modules/pkg/package.json': '{"exports":{"import":"./esm.js","require":"./cjs.js"}}', 'node_modules/pkg/esm.ts': '', 'node_modules/pkg/cjs.ts': '' } },
	{ name: 'ESM package condition', specifier: 'pkg', files: { 'package.json': '{"type":"module"}', 'node_modules/pkg/package.json': '{"exports":{"import":"./esm.js","require":"./cjs.js"}}', 'node_modules/pkg/esm.ts': '', 'node_modules/pkg/cjs.ts': '' } },
	{ name: 'custom condition', specifier: 'pkg', options: { customConditions: ['source'] }, files: { 'node_modules/pkg/package.json': '{"exports":{"source":"./source.ts","default":"./index.js"}}', 'node_modules/pkg/source.ts': '', 'node_modules/pkg/index.js': '' } },
	{ name: 'package imports', specifier: '#lib', files: { 'package.json': '{"imports":{"#lib":"./lib.js"}}', 'lib.ts': '' } },
	{ name: 'package imports external target', specifier: '#lib', files: { 'package.json': '{"imports":{"#lib":"pkg"}}', 'node_modules/pkg/index.ts': '' } },
	{ name: 'self reference', specifier: 'own/feature', files: { 'package.json': '{"name":"own","exports":{"./feature":"./feature.js"}}', 'feature.ts': '' } },
	{ name: 'typesVersions root', specifier: 'pkg', options: { moduleResolution: 'Node10' }, files: { 'node_modules/pkg/package.json': '{"types":"index.d.ts","typesVersions":{">=5.0":{"*": ["v5/*"]}}}', 'node_modules/pkg/index.d.ts': '', 'node_modules/pkg/v5/index.d.ts': '' } },
	{ name: 'typesVersions subpath', specifier: 'pkg/feature', options: { moduleResolution: 'Node10' }, files: { 'node_modules/pkg/package.json': '{"typesVersions":{"<5.0":{"*": ["old/*"]},">=5.0":{"*": ["new/*"]}}}', 'node_modules/pkg/feature.d.ts': '', 'node_modules/pkg/new/feature.d.ts': '' } },
	{ name: 'versioned types export', specifier: 'pkg', files: { 'node_modules/pkg/package.json': '{"exports":{"types@>=5.0":"./modern.d.ts","types":"./old.d.ts"}}', 'node_modules/pkg/modern.d.ts': '', 'node_modules/pkg/old.d.ts': '' } },
];

function virtualFiles(files: Record<string, string>) {
	const entries = new Map(Object.entries(files).map(([name, content]) => [path.resolve(root, name), content]));
	return {
		readFile: (file: string) => entries.get(path.resolve(file)),
		fileExists: (file: string) => entries.has(path.resolve(file)),
		directoryExists: (directory: string) => [...entries.keys()].some(file => file.startsWith(path.resolve(directory) + path.sep)),
	};
}

for (const fixture of cases) {
	test(`module resolution matches the compiler: ${fixture.name}`, () => {
		const filename = path.join(root, fixture.entry ?? 'main.ts');
		const host = virtualFiles(fixture.files);
		const compilerOptions = ts.convertCompilerOptionsFromJson({ module: 'NodeNext', moduleResolution: 'NodeNext', ...fixture.options }, root).options;
		if (fixture.options?.pathsBasePath) {
			(compilerOptions as ts.CompilerOptions & { pathsBasePath: string }).pathsBasePath = fixture.options.pathsBasePath;
		}
		const mode = ts.getImpliedNodeFormatForFile(filename as ts.Path, undefined, host, compilerOptions);
		const expected = ts.resolveModuleName(fixture.specifier, filename, compilerOptions, host, undefined, undefined,
			compilerOptions.moduleResolution === ts.ModuleResolutionKind.Bundler ? ts.ModuleKind.ESNext : mode).resolvedModule?.resolvedFileName;
		const resolver = new ModuleResolver(parseSource(filename, ''), { ...host, compilerOptions: fixture.options });
		assert.equal(resolver.resolve(fixture.specifier, filename), expected && path.resolve(expected));
	});
}

test('re-export chains, cycles, and unsaved sources preserve namespace-call safety', () => {
	const content = "import * as api from './barrel.js'; api.run();";
	for (const implementation of [
		'export function run(): void; export function run() {}',
		'export const run = () => 42;',
		'export default function() { return 42; }',
	]) {
		const host = virtualFiles({
			'barrel.ts': implementation.includes('default') ? "export { default as run } from './lib.js';" : "export * from './lib.js'; export * from './cycle.js';",
			'cycle.ts': "export * from './barrel.js';", 'lib.ts': implementation,
		});
		assert.equal(getNamespaceImportFixes(content, path.join(root, 'main.ts'), host).fixes.length, 1, implementation);
	}
	const host = virtualFiles({ 'barrel.ts': "export { run } from './lib.js';", 'lib.ts': 'export function run() { return this; }' });
	assert.equal(getNamespaceImportFixes(content, path.join(root, 'main.ts'), host).fixes.length, 0);
});

test('ambiguous star exports are not converted', () => {
	const host = virtualFiles({ 'barrel.ts': "export * from './a.js'; export * from './b.js';", 'a.ts': 'export const value = 1;', 'b.ts': 'export const value = 2;' });
	assert.equal(getNamespaceImportFixes("import * as api from './barrel.js'; api.value;", path.join(root, 'main.ts'), host).fixes.length, 0);
});

test('constructors do not require receiver-independent function bodies', () => {
	const host = virtualFiles({ 'lib.ts': 'export class Model { value = this; }' });
	assert.equal(getNamespaceImportFixes("import * as api from './lib.js'; new api.Model();", path.join(root, 'main.ts'), host).fixes.length, 1);
});

test('CommonJS named values are resolved while unknown receivers and shadowed exports are preserved', () => {
	const filename = path.join(root, 'main.ts');
	const content = "import * as api from './lib.js'; api.answer;";
	for (const implementation of ['exports.answer = 42;', 'module.exports.answer = 42;']) {
		assert.equal(getNamespaceImportFixes(content, filename, virtualFiles({ 'lib.js': implementation })).fixes.length, 1);
	}
	for (const implementation of ['const exports = {}; exports.answer = 42;', 'const module = { exports: {} }; module.exports.answer = 42;']) {
		assert.equal(getNamespaceImportFixes(content, filename, virtualFiles({ 'lib.js': implementation })).fixes.length, 0);
	}
	assert.equal(getNamespaceImportFixes("import * as api from './lib.js'; api.run();", filename, virtualFiles({ 'lib.js': 'exports.run = () => 42;' })).fixes.length, 0);
});

test('wrapped namespace objects are preserved and wrapped member calls keep receiver checks', () => {
	const host = virtualFiles({ 'lib.ts': 'export const answer = 42; export function run() { return this; }' });
	for (const use of ['(api).answer', 'api!.answer', '(api as any).answer', '(api.run)()', 'api.run!()', '(api.run as Function)()', 'api.run`tag`']) {
		const content = `import * as api from './lib.js'; ${use};`;
		assert.equal(getNamespaceImportFixes(content, path.join(root, 'main.ts'), host).fixes.length, 0, use);
	}
});
