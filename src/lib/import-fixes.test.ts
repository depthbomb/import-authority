import test from 'node:test';
import assert from 'node:assert/strict';
import { getImportFixes } from './organizer';
import type { OffsetEdit } from './text-edit';

function apply(content: string, edits: OffsetEdit[]): string {
	for (const edit of [...edits].sort((a, b) => b.start - a.start)) { content = content.slice(0, edit.start) + edit.newText + content.slice(edit.end); }
	return content;
}

test('quick fixes target a declaration or block without touching other code', () => {
	const first = "import { B } from 'pkg';\nimport { A } from 'pkg';\n";
	const rest = "run();\nimport { Z, Longer } from 'other';\nlet a: Longer;\n";
	const fixes = getImportFixes(first + rest);
	const duplicate = fixes.find(fix => fix.code === 'duplicate-import')!;
	assert.ok(apply(first + rest, duplicate.edits).endsWith(rest));
	assert.match(apply(first + rest, duplicate.edits), /import \{ A, B \} from 'pkg'/);
	const type = fixes.find(fix => fix.code === 'type-import')!;
	const converted = apply(first + rest, type.edits);
	assert.ok(converted.startsWith(first));
	assert.match(converted, /import type \{ Longer \}/);
	assert.ok(converted.endsWith('let a: Longer;\n'));
});

test('diagnostics honor settings, syntax and protected boundaries', () => {
	assert.deepEqual(getImportFixes("import { A } from 'a';\n"), []);
	assert.deepEqual(getImportFixes("import { from 'a';"), []);
	assert.deepEqual(getImportFixes("// import-authority-ignore-file\nimport { Z, A } from 'a';\n"), []);
	assert.deepEqual(getImportFixes("// import-authority-pin\nimport { Z, A } from 'a';\n"), []);
	assert.equal(getImportFixes("import { Model } from 'a';\nlet a: Model;\n", 'a.ts', { convertTypeOnlyImports: false }).some(fix => fix.code === 'type-import'), false);
});

test('Vue quick fixes map offsets back into the component', () => {
	const prefix = '<template><div /></template>\r\n<script setup lang="ts">\r\n';
	const suffix = '</script>\r\n<style>.a { color: red; }</style>';
	const content = prefix + "import { Z, A } from 'pkg';\r\n" + suffix;
	const fix = getImportFixes(content, 'a.vue')[0];
	const result = apply(content, fix.edits);
	assert.ok(result.startsWith(prefix));
	assert.ok(result.endsWith(suffix));
	assert.match(result, /import \{ A, Z \}/);
});
