import test from 'node:test';
import assert from 'node:assert/strict';
import { createMinimalOffsetEdit } from './text-edit';

test('returns no edit for unchanged content', () => {
	assert.equal(createMinimalOffsetEdit('same', 'same'), undefined);
});

test('limits an edit to the changed portion of a document', () => {
	const original = "import { B } from 'b';\n\nrun();\n";
	const updated = "import { A, B } from 'b';\n\nrun();\n";
	const edit = createMinimalOffsetEdit(original, updated);

	assert.deepEqual(edit, { start: 9, end: 9, newText: 'A, ' });
	assert.equal(
		`${original.slice(0, edit?.start)}${edit?.newText}${original.slice(edit?.end)}`,
		updated,
	);
});

test('supports deletion-only edits', () => {
	assert.deepEqual(createMinimalOffsetEdit('before middle after', 'before after'), {
		start: 7,
		end: 14,
		newText: '',
	});
});
