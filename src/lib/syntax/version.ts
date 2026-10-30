// Package declaration selection follows the language version this analyzer targets.
const languageVersion = [6, 0, 3];

function compare(left: number[], right: number[]): number {
	for (let index = 0; index < 3; index++) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference) {
			return difference;
		}
	}

	return 0;
}

function comparator(operator: string, text: string): boolean {
	const parts = text.split('.');
	const version: number[] = [];
	for (const part of parts) {
		if (/^[xX*]$/.test(part)) {
			break;
		}

		if (!/^\d+$/.test(part)) {
			return false;
		}

		version.push(Number(part));
	}

	if (version.length > 3) {
		return false;
	}

	const difference = compare(languageVersion, version);
	const next = [...version];
	if (next.length) {
		next[next.length - 1]++;
	}

	switch (operator) {
		case '>=':
			return difference >= 0;
		case '>':
			return version.length < 3 ? version.length > 0 && compare(languageVersion, next) >= 0 : difference > 0;
		case '<':
			return version.length > 0 && difference < 0;
		case '<=':
			return version.length < 3 ? version.length === 0 || compare(languageVersion, next) < 0 : difference <= 0;
		case '^':
		case '~': {
			const index = operator === '~' ? Math.min(1, version.length - 1) : version.findIndex(value => value !== 0);
			const upper = version.slice(0, index < 0 ? version.length : index + 1);
			if (upper.length) {
				upper[upper.length - 1]++;
			}

			return difference >= 0 && (!upper.length || compare(languageVersion, upper) < 0);
		}
		default:
			return version.length === 3 ? difference === 0 : version.length === 0 || difference >= 0 && compare(languageVersion, next) < 0;
	}
}

export function matchesLanguageVersion(range: string): boolean {
	return range.split('||').some(alternative => {
		const expanded = alternative.trim().replace(/([\d.xX*]+)\s+-\s+([\d.xX*]+)/g, '>=$1 <=$2');
		if (!expanded) {
			return true;
		}

		const expressions = [...expanded.matchAll(/(>=|<=|>|<|=|\^|~)?\s*([\d.xX*]+)/g)];
		if (!expressions.length || expanded.replace(/(>=|<=|>|<|=|\^|~)?\s*([\d.xX*]+)/g, '').trim()) {
			return false;
		}

		return expressions.every(match => comparator(match[1] ?? '', match[2]));
	});
}
