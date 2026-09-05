import ts from 'typescript';
import test from 'node:test';
import assert from 'node:assert/strict';
import { organizeImportsContent, removeUnusedImportsByScan } from './organizer';

test('indexed duplicate merging keeps the earliest compatible bindings after clause mutations', () => {
	const input = [
		...Array.from({ length: 100 }, (_, index) => `import Base${index} from 'm';`),
		"import * as Ns0 from 'm';", "import { foo } from 'm';",
		"import * as Ns1 from 'm';", "import { bar } from 'm';",
		...Array.from({ length: 100 }, (_, index) => `import type Type${index} from 'm';`),
		"import type { Shape } from 'm';", "import type * as Types from 'm';",
	].join('\n');
	const output = organizeImportsContent(input);
	assert.ok(output.includes("import Base0, * as Ns0 from 'm';"));
	assert.ok(output.includes("import Base1, { bar, foo } from 'm';"));
	assert.ok(output.includes("import Base2, * as Ns1 from 'm';"));
	assert.ok(output.includes("import type { Shape } from 'm';"));
	assert.ok(output.includes("import type * as Types from 'm';"));
	assert.equal(ts.createSourceFile('file.ts', output, ts.ScriptTarget.Latest).statements.length, 202);
	assert.equal(organizeImportsContent(output), output);
});

test('batch replacement preserves every statement across many import blocks', () => {
	const input = Array.from({ length: 250 }, (_, index) =>
		`import { Used${index}, Unused${index} } from 'module${index}';\nconsole.log(Used${index});`,
	).join('\r\n') + '\r\n';
	for (const transform of [organizeImportsContent, removeUnusedImportsByScan]) {
		const output = transform(input);
		const statements = ts.createSourceFile('file.ts', output, ts.ScriptTarget.Latest, true).statements;
		assert.equal(statements.length, 500);
		for (let index = 0; index < 250; index += 1) {
			assert.equal(statements[index * 2 + 1].getText(), `console.log(Used${index});`);
		}
		assert.equal(transform(output), output);
	}
});

test('normalizes paths once and preserves ambiguous repeated index suffixes', () => {
	for (const [inputPath, expectedPath] of [
		['./foo/index/index/index', './foo/index/index/index'],
		['./foo/index/index', './foo/index/index'],
		['./foo/../bar/index', './bar'],
		['./index', './'],
		['../index', '..'],
	]) {
		const options = { normalizeRelativePaths: true };
		const output = organizeImportsContent(`import { A } from '${inputPath}';\nconsole.log(A);\n`, 'file.ts', options);
		assert.ok(output.includes(`from '${expectedPath}'`));
		assert.equal(organizeImportsContent(output, 'file.ts', options), output);
	}
});

test('preserves detached comments, file headers and comments before directives exactly once', () => {
	for (const eol of ['\n', '\r\n']) {
		const input = [
			'// file header', '', '// explanation', '// @ts-check',
			"import { aaa } from 'a';", '', '// detached section', '',
			'// attached import comment', "import { b } from 'b';", '',
			'console.log(aaa, b);', '',
		].join(eol);
		for (const transform of [organizeImportsContent, removeUnusedImportsByScan]) {
			const output = transform(input);
			for (const comment of ['// file header', '// explanation', '// @ts-check', '// detached section', '// attached import comment']) {
				assert.equal(output.split(comment).length, 2);
			}
			assert.ok(output.startsWith(['// file header', '', '// explanation', '// @ts-check'].join(eol)));
			assert.ok(output.indexOf('// detached section') > output.indexOf("from 'a'"));
			assert.equal(transform(output), output);
		}
	}
});

test('scan fallback preserves implicit classic and custom JSX factory bindings', () => {
	for (const file of ['file.tsx', 'file.jsx', 'file.js']) {
		for (const input of [
			"import React from 'react';\nexport const node = <div />;\n",
			"import { h, Fragment } from 'preact';\nexport const node = <><div /></>;\n",
		]) {
			assert.equal(removeUnusedImportsByScan(input, file), input);
		}
	}
});

test('alignment preserves string literals and contextual from binding names', () => {
	const input = [
		'import { "a from b" as ab } from "m";',
		'import from from "n";',
		'import "side from effect";',
		'import SomethingVeryLong from "path from here";',
	].join('\n');
	const options = { alignFromKeyword: true };
	const output = organizeImportsContent(input, 'file.ts', options);
	const literals = (text: string): string[] => {
		const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
		const result: string[] = [];
		for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
			if (token === ts.SyntaxKind.StringLiteral) { result.push(scanner.getTokenValue()); }
		}
		return result.sort();
	};
	assert.deepEqual(literals(output), literals(input));
	assert.equal(organizeImportsContent(output, 'file.ts', options), output);
});

test('only merges import clauses allowed by TypeScript grammar', () => {
	for (const declarations of [
		["import type Foo from 'm';", "import type { Bar } from 'm';"],
		["import type Foo from 'm';", "import type * as Bar from 'm';"],
		["import {} from 'm';", "import * as ns from 'm';"],
	]) {
		for (const input of [declarations.join('\n'), [...declarations].reverse().join('\n')]) {
			const output = organizeImportsContent(input);
			const options = { noLib: true, noEmit: true };
			const host = ts.createCompilerHost(options);
			host.getSourceFile = (name, target) => name === 'file.ts'
				? ts.createSourceFile(name, output, target, true) : undefined;
			const program = ts.createProgram(['file.ts'], options, host);
			assert.deepEqual(program.getSyntacticDiagnostics(), []);
			assert.ok(!program.getSemanticDiagnostics().some(diagnostic => diagnostic.code === 1363));
			assert.equal(program.getSourceFile('file.ts')!.statements.length, 2);
			assert.equal(organizeImportsContent(output), output);
		}
	}
});

test('preserves executable code and complete comments following imports', () => {
	for (const eol of ['\n', '\r\n']) {
		for (const suffix of [' console.log(a);', ' /* start' + eol + 'end */' + eol + 'console.log(a);']) {
			const input = "import { a } from 'a';" + suffix + eol;
			for (const transform of [organizeImportsContent, removeUnusedImportsByScan]) {
				const output = transform(input);
				assert.ok(output.includes('console.log(a);'));
				if (suffix.includes('/*')) {
					assert.ok(output.includes('/* start' + eol + 'end */'));
				}
				assert.equal(transform(output), output);
			}
		}
	}
	assert.ok(removeUnusedImportsByScan("import { unused } from 'a'; run();").includes('run();'));
});

test('orders value imports first and type imports last by line length', () => {
	const input = [
		"import type { ZebraLongType } from 'zeta';",
		"import { Bee } from 'b';",
		"import Alpha from 'alpha';",
		"import type { A } from 'tiny';",
		'',
		'const x = 1;',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts');
	const expected = [
		"import { Bee } from 'b';",
		"import Alpha from 'alpha';",
		"import type { A } from 'tiny';",
		"import type { ZebraLongType } from 'zeta';",
		'',
		'const x = 1;',
	].join('\n');

	assert.equal(output, expected);
});

test('sorts named imports by length and forces one-line braces', () => {
	const input = [
		"import { LongestName, X, Mid } from 'pkg';",
		'',
		'console.log(1);',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts');
	assert.match(output, /import \{ X, Mid, LongestName \} from 'pkg';/);
	assert.doesNotMatch(output, /\{\s*\n/);
});

test('converts mixed type specifiers into dedicated type imports', () => {
	const input = [
		"import Foo, { type Zeta, B, type A, LongName } from 'mod';",
		'',
		'export const v = Foo;',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts');
	const expected = [
		"import Foo, { B, LongName } from 'mod';",
		"import type { A, Zeta } from 'mod';",
		'',
		'export const v = Foo;',
	].join('\n');

	assert.equal(output, expected);
	assert.doesNotMatch(output, /\{[^}]*\btype\b[^}]*\}/);
});

test('merges duplicate import declarations from same module per type bucket', () => {
	const input = [
		"import { B } from 'm';",
		"import { A } from 'm';",
		"import type { T2 } from 'm';",
		"import type { T1 } from 'm';",
		'',
		'void 0;',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts');
	const expected = [
		"import { A, B } from 'm';",
		"import type { T1, T2 } from 'm';",
		'',
		'void 0;',
	].join('\n');

	assert.equal(output, expected);
});

test('places default imports below non-default imports and sorts by length', () => {
	const input = [
		"import LongDefaultName from 'very-long';",
		"import { Mid } from 'pkg-mid';",
		"import S from 's';",
		"import * as Ns from 'namespace';",
		"import { A } from 'a';",
		'',
		'console.log(1);',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts');
	const expected = [
		"import { A } from 'a';",
		"import { Mid } from 'pkg-mid';",
		"import S from 's';",
		"import * as Ns from 'namespace';",
		"import LongDefaultName from 'very-long';",
		'',
		'console.log(1);',
	].join('\n');

	assert.equal(output, expected);
});

test('preserves leading comments attached to imports', () => {
	const input = [
		'// keep with zed',
		"import { Zed } from 'z';",
		'/* keep with alpha */',
		"import { A } from 'a';",
		'',
		'run();',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts');
	const expected = [
		'/* keep with alpha */',
		"import { A } from 'a';",
		'// keep with zed',
		"import { Zed } from 'z';",
		'',
		'run();',
	].join('\n');

	assert.equal(output, expected);
});

test('preserves detached file header comments before first import block', () => {
	const input = [
		'/* generated: do not edit */',
		'// @ts-nocheck',
		'',
		"import { B } from 'b';",
		"import { A } from 'a';",
		'',
		'init();',
		"import { C } from 'c';",
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts');
	const expected = [
		'/* generated: do not edit */',
		'// @ts-nocheck',
		'',
		"import { A } from 'a';",
		"import { B } from 'b';",
		'',
		'init();',
		"import { C } from 'c';",
		'',
	].join('\n');

	assert.equal(output, expected);
});

test('supports semicolon policy', () => {
	const input = [
		"import { A, Longer } from 'a';",
		'',
		'doThing();',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts', { semicolonPolicy: 'never' });
	const expected = [
		"import { A, Longer } from 'a'",
		'',
		'doThing();',
	].join('\n');

	assert.equal(output, expected);
});

test('supports preserving semicolon state', () => {
	const input = [
		"import { B } from 'b'",
		"import { A } from 'a';",
		'',
		'x();',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts', { semicolonPolicy: 'preserve' });
	const expected = [
		"import { B } from 'b'",
		"import { A } from 'a';",
		'',
		'x();',
	].join('\n');

	assert.equal(output, expected);
});

test('supports quote style policy', () => {
	const input = [
		'import { B } from "b";',
		"import { A } from 'a';",
		'',
		'x();',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts', {
		quoteStyle: 'double',
		semicolonPolicy: 'always',
	});
	const expected = [
		'import { A } from "a";',
		'import { B } from "b";',
		'',
		'x();',
	].join('\n');

	assert.equal(output, expected);
});

test('scan fallback removes unused imports while keeping side-effect imports', () => {
	const input = [
		"import { Used, Unused } from 'pkg';",
		"import SideEffect from 'side-effect-only';",
		"import 'setup';",
		'',
		'console.log(Used);',
	].join('\n');

	const output = removeUnusedImportsByScan(input, 'sample.ts');
	const expected = [
		"import { Used } from 'pkg';",
		"import 'setup';",
		'',
		'console.log(Used);',
	].join('\n');

	assert.equal(output, expected);
});

test('scan fallback handles type-only usage', () => {
	const input = [
		"import type { Keep, Drop } from 'types';",
		'',
		'const value: Keep = {} as Keep;',
	].join('\n');

	const output = removeUnusedImportsByScan(input, 'sample.ts');
	const expected = [
		"import type { Keep } from 'types';",
		'',
		'const value: Keep = {} as Keep;',
	].join('\n');

	assert.equal(output, expected);
});

test('groups imports with blank lines when enabled', () => {
	const input = [
		"import { local } from './local';",
		"import { join } from 'node:path';",
		"import { z } from 'z-lib';",
		"import { api } from '@app/api';",
		"import type { T } from './types';",
		'',
		'run();',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts', {
		groupImports: true,
		aliasPrefixes: ['@app'],
	});
	const expected = [
		"import { join } from 'node:path';",
		'',
		"import { z } from 'z-lib';",
		'',
		"import { api } from '@app/api';",
		'',
		"import { local } from './local';",
		'',
		"import type { T } from './types';",
		'',
		'run();',
	].join('\n');

	assert.equal(output, expected);
});

test('uses module specifier secondary ordering when configured', () => {
	const input = [
		"import { A } from 'b';",
		"import { A } from 'a';",
		'',
		'x();',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts', { moduleSpecifierOrder: 'alpha' });
	const expected = [
		"import { A } from 'a';",
		"import { A } from 'b';",
		'',
		'x();',
	].join('\n');

	assert.equal(output, expected);
});

test('places side-effect imports at top by default', () => {
	const input = [
		"import { B } from 'b';",
		"import 'setup';",
		'',
		'x();',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts');
	const expected = [
		"import 'setup';",
		"import { B } from 'b';",
		'',
		'x();',
	].join('\n');

	assert.equal(output, expected);
});

test('supports duplicate policy namedOnly', () => {
	const input = [
		"import { A } from 'm';",
		"import { B } from 'm';",
		"import D from 'm';",
		"import C from 'm';",
		'',
		'x();',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts', {
		duplicateImportPolicy: 'namedOnly',
	});
	const expected = [
		"import { A, B } from 'm';",
		"import C from 'm';",
		"import D from 'm';",
		'',
		'x();',
	].join('\n');

	assert.equal(output, expected);
});

test('inline style preserves the erasure of standalone type declarations', () => {
	const input = [
		"import type { Z, A } from 'types';",
		'',
		'void 0;',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts', {
		typeImportStyle: 'inline',
	});
	const expected = [
		"import type { A, Z } from 'types';",
		'',
		'void 0;',
	].join('\n');

	assert.equal(output, expected);
});

test('inline style keeps mixed bindings without adding runtime dependencies', () => {
	const input = "import { value, type Foo } from './runtime';\nimport type { Bar } from './types';\nconsole.log(value);\n";
	const options = { typeImportStyle: 'inline' as const };
	const output = organizeImportsContent(input, 'file.ts', options);
	assert.ok(output.includes("import { value, type Foo } from './runtime';"));
	assert.ok(output.includes("import type { Bar } from './types';"));
	const emit = (text: string): string => ts.transpileModule(text, {
		compilerOptions: { module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
	}).outputText;
	assert.equal(emit(output), emit(input));
	assert.equal(organizeImportsContent(output, 'file.ts', options), output);
});

test('normalizes relative paths when enabled', () => {
	const input = [
		"import { A } from './foo/index';",
		"import { B } from './../bar//baz';",
		'',
		'x();',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts', {
		normalizeRelativePaths: true,
		moduleSpecifierOrder: 'alpha',
	});
	const expected = [
		"import { A } from './foo';",
		"import { B } from '../bar/baz';",
		'',
		'x();',
	].join('\n');

	assert.equal(output, expected);
});

test('wraps named imports when unbroken line exceeds threshold', () => {
	const input = [
		"import { AlphaLong, BetaLong, GammaLong } from 'really-long-module-name';",
		'',
		'run();',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts', {
		namedImportsWrapThreshold: 55,
	});
	const expected = [
		"import {",
		"\tBetaLong,",
		"\tAlphaLong,",
		"\tGammaLong",
		"} from 'really-long-module-name';",
		'',
		'run();',
	].join('\n');

	assert.equal(output, expected);
});

test('keeps named imports on one line when threshold is not exceeded', () => {
	const input = [
		"import { BB, A, CCC } from 'm';",
		'',
		'run();',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts', {
		namedImportsWrapThreshold: 200,
	});
	const expected = [
		"import { A, BB, CCC } from 'm';",
		'',
		'run();',
	].join('\n');

	assert.equal(output, expected);
});

test('preserves trailing import comments and excludes them from length sorting', () => {
	const input = [
		"import { LongerName } from 'long-module';",
		"import { A } from 'a'; // keep this trailing comment",
		'',
		'run();',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts');
	const expected = [
		"import { A } from 'a'; // keep this trailing comment",
		"import { LongerName } from 'long-module';",
		'',
		'run();',
	].join('\n');

	assert.equal(output, expected);
});

test('aligns from keyword across single-line imports when enabled', () => {
	const input = [
		"import { One } from 'one';",
		"import { Sixteen } from 'sixteen';",
		"import { FourtyTwo } from 'fourty-two';",
		'',
		'run();',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts', { alignFromKeyword: true });
	const expected = [
		"import { One }       from 'one';",
		"import { Sixteen }   from 'sixteen';",
		"import { FourtyTwo } from 'fourty-two';",
		'',
		'run();',
	].join('\n');

	assert.equal(output, expected);
});

test('does not apply from-alignment to side-effect or multiline imports', () => {
	const input = [
		"import { AlphaLong, BetaLong, GammaLong } from 'really-long-module-name';",
		"import { One } from 'one';",
		"import 'setup';",
		'',
		'run();',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts', {
		alignFromKeyword: true,
		namedImportsWrapThreshold: 55,
	});
	const expected = [
		"import 'setup';",
		"import { One } from 'one';",
		"import {",
		"\tBetaLong,",
		"\tAlphaLong,",
		"\tGammaLong",
		"} from 'really-long-module-name';",
		'',
		'run();',
	].join('\n');

	assert.equal(output, expected);
});

test('re-sorts by aligned lengths when from-alignment is enabled', () => {
	const input = [
		"import { VeryLongImportedIdentifier } from 'x';",
		"import { A } from 'abcdefghijklmnop';",
		'',
		'run();',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts', { alignFromKeyword: true });
	const expected = [
		"import { VeryLongImportedIdentifier } from 'x';",
		"import { A }                          from 'abcdefghijklmnop';",
		'',
		'run();',
	].join('\n');

	assert.equal(output, expected);
});

test('aligns from keyword per group when grouping is enabled', () => {
	const input = [
		"import { VeryLongBuiltinName } from 'node:fs';",
		"import { A } from 'z-lib';",
		"import { Mid } from 'another-lib';",
		'',
		'run();',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts', {
		alignFromKeyword: true,
		groupImports: true,
	});
	const expected = [
		"import { VeryLongBuiltinName } from 'node:fs';",
		'',
		"import { A }   from 'z-lib';",
		"import { Mid } from 'another-lib';",
		'',
		'run();',
	].join('\n');

	assert.equal(output, expected);
});

test('preserves separation when imports appear after executable code', () => {
	const input = [
		'if (!condition) {',
		"\tthrow new Error();",
		'}',
		'',
		"import 'something';",
		"import 'something-else';",
		'',
		'run();',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts');
	const expected = [
		'if (!condition) {',
		"\tthrow new Error();",
		'}',
		'',
		"import 'something';",
		"import 'something-else';",
		'',
		'run();',
	].join('\n');

	assert.equal(output, expected);
});

test('preserves executable statements between separate import blocks', () => {
	const input = [
		"import { platform, assertRuntime } from '@depthbomb/node-common/platform';",
		'',
		"assertRuntime('bun');",
		'',
		"import '@extensions/string';",
		"import '@abraham/reflection';",
		"import 'temporal-polyfill/global';",
		"import { env } from '@env';",
		"import { container } from '@container';",
		"import { WeatherGoat } from '@lib/client';",
		"import { CliService } from '@services/cli';",
		"import { Flag } from '@depthbomb/common/state';",
		"import { logger, reportError } from '@lib/logger';",
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts');
	assert.match(output, /assertRuntime\('bun'\);/);
	assert.match(output, /import \{ platform, assertRuntime \} from '@depthbomb\/node-common\/platform';/);
	assert.match(output, /import '@extensions\/string';/);
	assert.ok(output.indexOf("assertRuntime('bun');") < output.indexOf("import '@extensions/string';"));
});

test('preserves import attributes while organizing and merging', () => {
	const input = [
		"import { B } from './data.json' with { type: 'json' };",
		"import { A } from './data.json' with { type: 'json' };",
		'',
		'console.log(A, B);',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts');
	assert.equal(output, [
		"import { A, B } from './data.json' with { type: 'json' };",
		'',
		'console.log(A, B);',
	].join('\n'));
});

test('preserves string-named import specifiers', () => {
	const input = "import { 'a-b' as ab } from 'pkg';\n\nconsole.log(ab);";
	assert.equal(organizeImportsContent(input, 'sample.ts'), input);
});

test('escapes module specifiers when enforcing quote style', () => {
	const input = 'import { A } from "it\\\'s\\\\nested";\n\nconsole.log(A);';
	const output = organizeImportsContent(input, 'sample.ts', { quoteStyle: 'single' });
	assert.equal(output, "import { A } from 'it\\\'s\\\\nested';\n\nconsole.log(A);");
});

test('always policy combines compatible default and named imports', () => {
	const input = [
		"import D from 'm';",
		"import { A } from 'm';",
		'',
		'console.log(D, A);',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts');
	assert.equal(output, "import D, { A } from 'm';\n\nconsole.log(D, A);");
});

test('scan fallback preserves import attributes and string-named specifiers', () => {
	const input = [
		"import data, { 'a-b' as ab, Unused } from './data.json' with { type: 'json' };",
		'',
		'console.log(data, ab);',
	].join('\n');

	const output = removeUnusedImportsByScan(input, 'sample.ts');
	assert.equal(output, [
		"import data, { 'a-b' as ab } from './data.json' with { type: 'json' };",
		'',
		'console.log(data, ab);',
	].join('\n'));
});

test('scan fallback does not count property names as binding usage', () => {
	const input = [
		"import { Foo, Keep } from 'pkg';",
		'',
		'const value = { Foo: 1 };',
		'console.log(value.Foo, Keep);',
	].join('\n');

	const output = removeUnusedImportsByScan(input, 'sample.ts');
	assert.equal(output, [
		"import { Keep } from 'pkg';",
		'',
		'const value = { Foo: 1 };',
		'console.log(value.Foo, Keep);',
	].join('\n'));
});

test('leaves malformed source unchanged instead of guessing at incomplete imports', () => {
	const input = "import { B } from 'b';\nimport { A } from ;\n\nrun(B);";
	assert.equal(organizeImportsContent(input, 'sample.ts'), input);
	assert.equal(removeUnusedImportsByScan(input, 'sample.ts'), input);
});

test('preserves comments inside import declarations without duplicating mixed imports', () => {
	const input = [
		"import { Z } from 'z';",
		"import { V, /* explanation */ type T } from 'pkg';",
		'',
		'console.log(V);',
	].join('\n');
	const output = organizeImportsContent(input, 'sample.ts');
	assert.equal(output.match(/explanation/g)?.length, 1);
	assert.equal(output.match(/from 'pkg'/g)?.length, 1);
	assert.match(output, /import \{ V, \/\* explanation \*\/ type T \} from 'pkg';/);
});

test('preserves empty value imports and deferred imports', () => {
	const input = [
		"import defer * as deferred from 'deferred';",
		"import {} from './setup';",
		"import { A } from 'a';",
		'',
		'console.log(A, deferred);',
	].join('\n');
	const output = organizeImportsContent(input, 'sample.ts');
	assert.match(output, /import \{\} from '\.\/setup';/);
	assert.match(output, /import defer \* as deferred from 'deferred';/);
	assert.match(removeUnusedImportsByScan(input, 'sample.ts'), /import \{\} from '\.\/setup';/);
});

test('preserves inline-only type imports that retain runtime module evaluation', () => {
	const input = "import { type Foo } from './setup';\n\nconst value: Foo = {};";
	assert.equal(organizeImportsContent(input, 'sample.ts'), input);
	assert.equal(removeUnusedImportsByScan("import { type Foo } from './setup';\n\nrun();", 'sample.ts'), "import { type Foo } from './setup';\n\nrun();");
});

test('preserves relative order among side-effect imports', () => {
	const input = [
		"import './longer-side-effect';",
		"import {} from './empty-value-import';",
		"import { type RuntimeType } from './inline-type-import';",
		"import './a';",
		"import { B } from 'b';",
		'',
		'console.log(B);',
	].join('\n');
	const output = organizeImportsContent(input, 'sample.ts');
	assert.ok(output.indexOf("'./longer-side-effect'") < output.indexOf("'./a'"));
	assert.ok(output.indexOf("'./longer-side-effect'") < output.indexOf("'./empty-value-import'"));
	assert.ok(output.indexOf("'./empty-value-import'") < output.indexOf("'./inline-type-import'"));
	assert.ok(output.indexOf("'./inline-type-import'") < output.indexOf("'./a'"));
});

test('keeps compiler and JSX directives ahead of organized imports', () => {
	const input = [
		'/// <reference types="node" />',
		'/** @jsxImportSource preact */',
		'// @ts-nocheck',
		"import { LongName } from 'long';",
		"import { A } from 'a';",
		'',
		'run(A, LongName);',
	].join('\n');
	const output = organizeImportsContent(input, 'sample.ts');
	assert.ok(output.indexOf('/// <reference') < output.indexOf("import { A }"));
	assert.ok(output.indexOf('@jsxImportSource') < output.indexOf("import { A }"));
	assert.ok(output.indexOf('@ts-nocheck') < output.indexOf("import { A }"));
});

test('scan fallback preserves file directives when every import is removed', () => {
	const input = [
		'// @ts-nocheck',
		"import { Unused } from 'pkg';",
		'',
		'undeclared();',
	].join('\n');
	assert.equal(removeUnusedImportsByScan(input, 'sample.ts'), '// @ts-nocheck\nundeclared();');
});

test('does not discard directive-like comments attached to later imports', () => {
	const input = [
		"import { A } from 'a';",
		'/** @license dependency license */',
		"import { LongName } from 'long';",
		'',
		'run(A, LongName);',
	].join('\n');
	assert.match(organizeImportsContent(input, 'sample.ts'), /@license dependency license/);
});

test('scan fallback treats JSDoc type names as uses and preserves commented imports', () => {
	const input = [
		'// rationale for keeping this import',
		"import { Commented } from 'commented'; // trailing detail",
		"import { Foo } from 'types';",
		'',
		'/** @type {Foo} */',
		'let value;',
	].join('\n');
	const output = removeUnusedImportsByScan(input, 'sample.js');
	assert.match(output, /import \{ Commented \} from 'commented'; \/\/ trailing detail/);
	assert.match(output, /import \{ Foo \} from 'types';/);
});

test('organizes both Vue script blocks while preserving template and style content', () => {
	const input = [
		'<template>',
		'  <button>{{ label }}</button>',
		'</template>',
		'',
		'<script lang="ts">',
		"import { Longer } from 'long';",
		"import { A } from 'a';",
		'export default { setup: () => ({ A, Longer }) };',
		'</script>',
		'',
		'<script setup lang="tsx">',
		"import Zed from 'zed-package';",
		"import { B } from 'b';",
		'console.log(B, Zed);',
		'</script>',
		'',
		'<style>',
		"@import './theme.css';",
		"@import './base.css';",
		'</style>',
	].join('\n');
	const output = organizeImportsContent(input, 'Component.vue');
	assert.ok(output.indexOf("import { A } from 'a';") < output.indexOf("import { Longer } from 'long';"));
	assert.ok(output.indexOf("import { B } from 'b';") < output.indexOf("import Zed from 'zed-package';"));
	assert.match(output, /<template>\n  <button>\{\{ label \}\}<\/button>\n<\/template>/);
	assert.match(output, /<style>\n@import '\.\/theme\.css';\n@import '\.\/base\.css';\n<\/style>/);
});

test('ignores nested, external, and unsupported Vue script blocks', () => {
	const input = [
		'<!-- <script>import bad from "comment"</script> -->',
		'<template><template v-if="ok"><script>import bad from "template"</script></template></template>',
		'<script src="./external.ts"></script>',
		'<script lang="coffee">import bad from "coffee"</script>',
	].join('\n');
	assert.equal(organizeImportsContent(input, 'Component.vue'), input);
	assert.equal(removeUnusedImportsByScan(input, 'Component.vue'), input);
});

test('supports case-insensitive Vue tags and quoted greater-than attributes', () => {
	const input = [
		'<SCRIPT data-example=">" setup LANG = TS>',
		"import { Longer } from 'long';",
		"import { A } from 'a';",
		'console.log(A, Longer);',
		'</SCRIPT>',
	].join('\r\n');
	const output = organizeImportsContent(input, 'Component.vue');
	assert.ok(output.indexOf("import { A } from 'a';") < output.indexOf("import { Longer } from 'long';"));
	assert.ok(output.includes('\r\n'));
});

test('leaves a malformed Vue SFC unchanged', () => {
	const input = "<script setup lang='ts'>\nimport { B } from 'b';\nimport { A } from 'a';";
	assert.equal(organizeImportsContent(input, 'Component.vue'), input);
});

test('never scan-prunes Vue bindings that may be consumed by the template', () => {
	const input = [
		'<script setup>',
		"import MyButton from './MyButton.vue';",
		'</script>',
		'<template><MyButton /></template>',
	].join('\n');
	assert.equal(removeUnusedImportsByScan(input, 'Component.vue'), input);
});
