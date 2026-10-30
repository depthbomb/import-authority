import ts from 'typescript';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { readProjectConfig, parseJsonConfig } from './project-config';
import { matchesLanguageVersion } from './syntax/version';

function fixture(files: Record<string, string>) {
	const root = mkdtempSync(path.join(os.tmpdir(), 'import-authority-config-'));
	for (const [name, content] of Object.entries(files)) {
		const filename = path.join(root, name);
		mkdirSync(path.dirname(filename), { recursive: true });
		writeFileSync(filename, content);
	}
	return path.join(root, 'tsconfig.json');
}

test('JSONC preserves quoted comment markers, Unicode, and trailing commas', () => {
	const value = parseJsonConfig('\ufeff{/*comment*/"url":"https://example.test", "list":[1, -2.5e+2, true, null,], "name":"\\u03bb",}') as Record<string, unknown>;
	assert.deepEqual(value.list, [1, -250, true, null]);
	assert.equal(value.url, 'https://example.test');
	assert.equal(value.name, 'λ');
	for (const content of ['{"x":}', '{"x":1} extra', '{"x": "unterminated}', '/* unterminated', '{"x":0x10}', '{"x":1_0}']) {
		assert.throws(() => parseJsonConfig(content), SyntaxError);
	}
});

test('config inheritance preserves declaring directories, replacement semantics, and configDir', () => {
	const filename = fixture({
		'tsconfig.json': '{"extends":["./base/first","./base/second"], "compilerOptions":{"jsxFactory":"local.h"}}',
		'base/first.json': '{"compilerOptions":{"baseUrl":"./src", "paths":{"@old/*":["old/*"]}, "jsxFactory":"base.h", "moduleSuffixes":[".native", ""]}}',
		'base/second.json': '{"compilerOptions":{"paths":{"@app/*":["${configDir}/app/*"]}, "rootDirs":["./shared","${configDir}/generated"], "jsxFragmentFactory":"local.Fragment"}}',
	});
	const actual = readProjectConfig(filename)?.options;
	const expected = ts.getParsedCommandLineOfConfigFile(filename, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} })?.options;
	assert.ok(actual);
	assert.ok(expected);
	for (const key of ['baseUrl', 'paths', 'rootDirs', 'jsxFactory', 'jsxFragmentFactory', 'moduleSuffixes']) {
		const normalize = (value: unknown): unknown => typeof value === 'string' ? value.replaceAll('\\', '/')
			: Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
				? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalize(item)])) : value;
		assert.deepEqual(normalize(actual[key]), normalize(expected[key]), key);
	}
});

test('package config inheritance and paths without baseUrl retain their origins', () => {
	const filename = fixture({
		'tsconfig.json': '{"extends":"@settings/base"}',
		'node_modules/@settings/base/package.json': '{"tsconfig":"config/strict.json"}',
		'node_modules/@settings/base/config/strict.json': '{"compilerOptions":{"paths":{"@app/*":["src/*"]}}}',
	});
	const options = readProjectConfig(filename)?.options;
	assert.equal(options?.pathsBasePath, path.join(path.dirname(filename), 'node_modules/@settings/base/config'));
	assert.deepEqual(options?.paths, { '@app/*': ['src/*'] });
});

test('extended configs follow package exports and conditional wildcard targets', () => {
	for (const specifier of ['@settings/base', '@settings/base/shared']) {
		const filename = fixture({
			'tsconfig.json': JSON.stringify({ extends: specifier }),
			'node_modules/@settings/base/package.json': JSON.stringify({ exports: { '.': { types: './configs/shared.json' }, './*': './configs/*.json' } }),
			'node_modules/@settings/base/configs/shared.json': '{"compilerOptions":{"jsxFactory":"custom.h"}}',
		});
		const expected = ts.getParsedCommandLineOfConfigFile(filename, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} });
		assert.equal(expected?.options.jsxFactory, 'custom.h');
		assert.equal(readProjectConfig(filename)?.options.jsxFactory, expected?.options.jsxFactory);
	}
});

test('missing and circular parents preserve local options, malformed options cannot reach consumers', () => {
	for (const files of [
		{ 'tsconfig.json': '{"extends":"./missing"}' },
		{ 'tsconfig.json': '{"extends":"./base"}', 'base.json': '{"extends":"./tsconfig"}' },
	] as Record<string, string>[]) {
		assert.deepEqual(readProjectConfig(fixture(files))?.options, {});
	}
	assert.equal(readProjectConfig(fixture({ 'tsconfig.json': '{invalid' })), undefined);
	const options = readProjectConfig(fixture({ 'tsconfig.json': '{"compilerOptions":{"jsxFactory":12,"paths":true,"rootDirs":12,"moduleSuffixes":[12],"customConditions":true}}' }))?.options;
	assert.deepEqual(options, {});
});

test('declaration version conditions follow the targeted language version', () => {
	assert.equal(ts.versionMajorMinor, '6.0', 'Update the syntax compatibility target when upgrading the compiler oracle');
	for (const range of ['*', '>=5', '>=5.5 <7', '^6.0', '~6.0', '6', '6.x', '6.0.*', '5.5 - 6.1', '<5 || >=6', '<=6', '>5']) {
		assert.equal(matchesLanguageVersion(range), true, range);
	}
	for (const range of ['<6', '>=7', '^5', '~5.9', '6.1', '<=5', '>6', 'invalid']) {
		assert.equal(matchesLanguageVersion(range), false, range);
	}
});
