import { matchesLanguageVersion } from './syntax/version';

function packageTarget(value: unknown, conditions: Set<string>): string[] {
	if (typeof value === 'string') {
		return [value];
	}

	if (Array.isArray(value)) {
		return value.flatMap(entry => packageTarget(entry, conditions));
	}

	if (value && typeof value === 'object') {
		const results: string[] = [];
		for (const [condition, target] of Object.entries(value)) {
			if (conditions.has(condition) || condition.startsWith('types@') && matchesLanguageVersion(condition.slice(6))) {
				if (target === null) {
					break;
				}
				results.push(...packageTarget(target, conditions));
			}
		}

		return results;
	}

	return [];
}

export function patternMatch(pattern: string, value: string): string | undefined {
	const star = pattern.indexOf('*');
	if (star < 0) {
		return pattern === value ? '' : undefined;
	}

	const prefix = pattern.slice(0, star);
	const suffix = pattern.slice(star + 1);

	return value.startsWith(prefix) && value.endsWith(suffix) && value.length >= prefix.length + suffix.length
		? value.slice(prefix.length, suffix ? -suffix.length : undefined) : undefined;
}

export function matchedKey(keys: string[], value: string): string | undefined {
	return keys.filter(key => patternMatch(key, value) !== undefined).sort((a, b) => {
		if (!a.includes('*')) {
			return -1;
		}

		if (!b.includes('*')) {
			return 1;
		}

		return b.indexOf('*') - a.indexOf('*') || b.length - a.length;
	})[0];
}

export function packageTargets(map: unknown, key: string, conditions: Set<string>): string[] {
	let target = map;
	let wildcard = '';
	if (map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).some(key => key.startsWith('.') || key.startsWith('#'))) {
		const matched = matchedKey(Object.keys(map), key);
		if (!matched) {
			return [];
		}

		target = (map as Record<string, unknown>)[matched];
		wildcard = patternMatch(matched, key)!;
	} else if (key !== '.') {
		return [];
	}

	return packageTarget(target, conditions).map(entry => entry.replaceAll('*', wildcard));
}
