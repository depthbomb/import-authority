import test from 'node:test';
import assert from 'node:assert/strict';
import { organizeImportsContent, removeUnusedImportsByScan } from './organizer';

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

test('supports inline type import style', () => {
	const input = [
		"import type { Z, A } from 'types';",
		'',
		'void 0;',
	].join('\n');

	const output = organizeImportsContent(input, 'sample.ts', {
		typeImportStyle: 'inline',
	});
	const expected = [
		"import { type A, type Z } from 'types';",
		'',
		'void 0;',
	].join('\n');

	assert.equal(output, expected);
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
