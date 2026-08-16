export type OffsetEdit = {
	start: number;
	end: number;
	newText: string;
};

export function createMinimalOffsetEdit(original: string, updated: string): OffsetEdit | undefined {
	if (original === updated) {
		return undefined;
	}

	let start = 0;
	const shortestLength = Math.min(original.length, updated.length);
	while (start < shortestLength && original[start] === updated[start]) {
		start += 1;
	}

	let end = original.length;
	let updatedEnd = updated.length;
	while (end > start && updatedEnd > start && original[end - 1] === updated[updatedEnd - 1]) {
		end -= 1;
		updatedEnd -= 1;
	}

	return { start, end, newText: updated.slice(start, updatedEnd) };
}
