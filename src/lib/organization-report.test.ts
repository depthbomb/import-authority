import test from 'node:test';
import assert from 'node:assert/strict';
import { organizeImportsContent, organizeImportsWithReport } from './organizer';
import { describeOrganization } from './organization-report';

test('reports merge and movement counts without changing organizer output', () => {
	const content = "import { LongName } from 'long';\nimport { A } from 'a';\nimport { B } from 'long';\n";
	const report = organizeImportsWithReport(content);
	assert.equal(report.content, organizeImportsContent(content));
	assert.equal(report.merged, 1);
	assert.equal(report.moved, 2);
	assert.equal(report.importCount, 3);
	assert.equal(report.bindings.size, 3);
	const unchanged = organizeImportsWithReport(report.content);
	assert.equal(unchanged.merged, 0);
	assert.equal(unchanged.moved, 0);
	assert.match(describeOrganization(unchanged, false, 0, []), /already organized/);
	const sideEffects = organizeImportsWithReport("import 'polyfill';\nimport { A } from 'a';\n");
	assert.equal(sideEffects.moved, 0);
});

test('reports syntax, directive and Vue skip reasons accurately', () => {
	for (const [content, filePath, reason] of [
		["import { from 'a';", 'a.ts', 'syntax-error'],
		["// import-authority-ignore-file\nimport { B, A } from 'a';", 'a.ts', 'ignored-file'],
		["// import-authority-pin\nimport { B, A } from 'a';", 'a.ts', 'protected-imports'],
		['console.log(1);', 'a.ts', 'no-imports'],
		['<script src="./a.ts"></script>', 'a.vue', 'no-supported-scripts'],
		['<script>import A from "a";', 'a.vue', 'malformed-vue'],
	]) {
		const report = organizeImportsWithReport(content, filePath);
		assert.ok(report.reasons.includes(reason as typeof report.reasons[number]));
		assert.doesNotMatch(describeOrganization(report, false, 0, []), /already organized/);
		assert.equal(report.content, content);
	}
});

test('aggregates Vue counts and distinguishes identical bindings across script blocks', () => {
	const script = "import { LongName } from 'long';\nimport { A } from 'a';\n";
	const report = organizeImportsWithReport(`<script>\n${script}</script>\n<script setup>\n${script}</script>`, 'a.vue');
	assert.equal(report.moved, 4);
	assert.equal(report.bindings.size, 4);
	const mixed = organizeImportsWithReport(`<script>import {</script><script setup>\n${script}</script>`, 'a.vue');
	assert.deepEqual(mixed.reasons, ['syntax-error']);
	assert.equal(mixed.moved, 2);
	const unsupported = organizeImportsWithReport(`<script src="./a.ts"/><script setup>\n${script}</script>`, 'a.vue');
	assert.deepEqual(unsupported.reasons, ['unsupported-scripts']);
	assert.equal(unsupported.moved, 2);
});
