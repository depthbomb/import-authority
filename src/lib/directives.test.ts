import test from 'node:test';
import assert from 'node:assert/strict';
import { organizeImportsContent, removeUnusedImportsByScan, hasImportAuthorityDirectives } from './organizer';

const pair   = "import { LongName, B } from 'long';\nimport { A } from 'a';\n";
const sorted = "import { A } from 'a';\nimport { B, LongName } from 'long';\n";

test('ignore and pin preserve imports verbatim and prevent merging or sorting across them', () => {
	for (const directive of ['ignore', 'pin']) {
		for (const eol of ['\n', '\r\n']) {
			const pinned   = `// import-authority-${directive}\nimport { Keep, Longer } from "long"; // keep this\n`;
			const input    = (pair + pinned + pair).replaceAll('\n', eol);
			const expected = (sorted + '\n' + pinned + sorted).replaceAll('\n', eol);
			assert.equal(organizeImportsContent(input), expected);
			assert.equal(organizeImportsContent(expected), expected);
			assert.ok(removeUnusedImportsByScan(input).includes(pinned.replaceAll('\n', eol)));
		}
	}
});

test('off/on regions retain exact contents and on markers stay before the resumed block', () => {
	const disabled = `// import-authority-off\n${pair}run();\n${pair}// import-authority-on\n`;
	const input    = pair + disabled + pair;
	const expected = sorted + '\n' + disabled + sorted;
	assert.equal(organizeImportsContent(input), expected);
	assert.equal(organizeImportsContent(expected), expected);
	assert.equal(removeUnusedImportsByScan(input), disabled);
});

test('nested regions and unmatched off remain protected through their scope', () => {
	const prefix = `// import-authority-off\n${pair}// import-authority-off\n${pair}// import-authority-on\n${pair}`;
	assert.equal(organizeImportsContent(prefix), prefix);

	const input = `${prefix}// import-authority-on\n${pair}`;
	assert.equal(organizeImportsContent(input), `${prefix}// import-authority-on\n${sorted}`);
	assert.equal(organizeImportsContent(`// import-authority-on\n${pair}`), `// import-authority-on\n${sorted}`);
});

test('ignore-file prevents organization and scan removal including file headers', () => {
	for (const marker of ['// import-authority-ignore-file', '/* import-authority-ignore-file */']) {
		const input = `#!/usr/bin/env node\n// license\n${marker}\n\n${pair}`;
		assert.equal(organizeImportsContent(input), input);
		assert.equal(removeUnusedImportsByScan(input), input);
		assert.ok(hasImportAuthorityDirectives(input));
	}
});

test('directive-looking strings, templates and unrelated comments do not disable organization', () => {
	const suffix = 'const a = "// import-authority-ignore-file";\nconst b = `\n// import-authority-off\n`;\n';
	const input  = pair + suffix;
	assert.equal(organizeImportsContent(input), sorted + '\n' + suffix);
	assert.equal(hasImportAuthorityDirectives(input), false);
	assert.equal(hasImportAuthorityDirectives(`// mentions import-authority-ignore-file\n${pair}`), false);
	assert.equal(hasImportAuthorityDirectives(`// import-authority-ignore-file-extra\n${pair}`), false);
});

test('Vue directives protect script imports without changing templates or styles', () => {
	const prefix         = `<template><!-- import-authority-ignore-file --><div /></template>\n<script setup lang="ts">\n`;
	const suffix         = '</script>\n<style>.a { color: red }</style>';
	const protectedBlock = `// import-authority-off\n${pair}// import-authority-on\n`;
	assert.equal(organizeImportsContent(prefix + protectedBlock + pair + suffix, 'app.vue'), prefix + protectedBlock + sorted + suffix);
	assert.ok(hasImportAuthorityDirectives(prefix + protectedBlock + pair + suffix, 'app.vue'));

	const ignored = prefix + `// import-authority-ignore-file\n${pair}` + suffix + `\n<script>\n${pair}</script>`;
	assert.equal(organizeImportsContent(ignored, 'app.vue'), ignored);
});
