import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { Scanner } from './syntax/scanner';
import type { Token } from './syntax/scanner';
import { packageTargets } from './package-map';

export type CompilerOptions = {
	baseUrl?:                    string;
	paths?:                      Record<string, string[]>;
	pathsBasePath?:              string;
	rootDirs?:                   string[];
	moduleSuffixes?:             string[];
	jsxFactory?:                 string;
	jsxFragmentFactory?:         string;
	module?:                     string | number;
	moduleResolution?:           string | number;
	customConditions?:           string[];
	resolvePackageJsonExports?:  boolean;
	resolvePackageJsonImports?:  boolean;
	allowImportingTsExtensions?: boolean;
	[key: string]: unknown;
};

class JsonReader {
	private token: Token;
	private readonly scanner: Scanner;

	public constructor(text: string) {
		this.scanner = new Scanner(text);
		this.token = this.scanner.next();
	}

	public read(): unknown {
		const value = this.value();
		if (this.token.kind !== 'eof' || this.scanner.errors.length) {
			throw new SyntaxError('Invalid JSON configuration');
		}

		return value;
	}

	private take(text: string): boolean {
		if (this.token.text !== text || this.token.kind === 'string') {
			return false;
		}

		this.token = this.scanner.next();

		return true;
	}

	private expect(text: string): void {
		if (!this.take(text)) {
			throw new SyntaxError(`Expected ${text} in configuration`);
		}
	}

	private value(): unknown {
		if (this.take('{')) {
			const object: Record<string, unknown> = Object.create(null);
			if (!this.take('}')) {
				do {
					if (this.token.kind !== 'string') {
						throw new SyntaxError('Expected a JSON property');
					}

					const key = this.token.text;
					this.token = this.scanner.next();
					this.expect(':');
					object[key] = this.value();
					if (!this.take(',')) {
						break;
					}
				} while (this.token.text !== '}');
				this.expect('}');
			}

			return object;
		}

		if (this.take('[')) {
			const values: unknown[] = [];
			if (!this.take(']')) {
				do {
					values.push(this.value());
					if (!this.take(',')) {
						break;
					}
				} while (this.token.text !== ']');
				this.expect(']');
			}

			return values;
		}

		if (this.token.kind === 'string') {
			const value = this.token.text;
			this.token = this.scanner.next();

			return value;
		}

		if (this.take('true')) {
			return true;
		}

		if (this.take('false')) {
			return false;
		}

		if (this.take('null')) {
			return null;
		}

		const negative = this.take('-');
		if (this.token.kind !== 'number' || !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(this.token.text)) {
			throw new SyntaxError('Expected a JSON value');
		}

		const value = Number(this.token.text) * (negative ? -1 : 1);
		this.token = this.scanner.next();

		return value;
	}
}

function configCandidate(candidate: string): string | undefined {
	for (const file of [candidate, `${candidate}.json`]) {
		if (fileExists(file)) {
			return file;
		}
	}

	const packageText = readFile(path.join(candidate, 'package.json'));
	if (packageText) {
		const manifest = JSON.parse(packageText);
		if (typeof manifest.tsconfig === 'string') {
			const file = path.resolve(candidate, manifest.tsconfig);
			if (fileExists(file)) {
				return file;
			}
		}
	}

	const file = path.join(candidate, 'tsconfig.json');

	return fileExists(file) ? file : undefined;
}

function resolveExtendedConfig(specifier: string, directory: string): string | undefined {
	if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
		return configCandidate(path.resolve(directory, specifier));
	}

	const segments = specifier.split('/');
	const name     = segments.splice(0, specifier.startsWith('@') ? 2 : 1).join('/');
	const key      = segments.length ? `./${segments.join('/')}` : '.';
	for (let current = directory; ; current = path.dirname(current)) {
		const root    = path.join(current, 'node_modules', name);
		const text    = readFile(path.join(root, 'package.json'));
		const exports = text && JSON.parse(text)?.exports;
		if (exports !== undefined && exports !== '') {
			for (const target of packageTargets(exports, key, new Set(['types', 'require', 'node', 'default']))) {
				if (!target.startsWith('./')) {
					continue;
				}

				const candidate = path.resolve(root, target);
				const relative  = path.relative(root, candidate);
				if (!relative.startsWith('..') && !path.isAbsolute(relative) && fileExists(candidate)) {
					return candidate;
				}
			}

			if (path.dirname(current) === current) {
				return undefined;
			}
			continue;
		}

		const resolved = configCandidate(path.join(root, ...segments));
		if (resolved || path.dirname(current) === current) {
			return resolved;
		}
	}
}

function loadConfig(filename: string, seen: Set<string>, configDirectory: string): CompilerOptions {
	const file = path.resolve(filename);
	const key  = process.platform === 'win32' ? file.toLowerCase() : file;
	if (seen.has(key)) {
		return {};
	}

	seen.add(key);
	const text = readFile(file);
	if (text === undefined) {
		throw new Error('Missing configuration');
	}

	const config = parseJsonConfig(text) as { extends?: string | string[]; compilerOptions?: CompilerOptions };
	if (!config || typeof config !== 'object' || Array.isArray(config)) {
		throw new Error('Invalid configuration');
	}

	let options: CompilerOptions = {};
	const directory = path.dirname(file);
	const parents   = typeof config.extends === 'string' ? [config.extends] : Array.isArray(config.extends) ? config.extends.filter(value => typeof value === 'string') : [];
	for (const parent of parents) {
		const resolved = resolveExtendedConfig(parent, directory);
		if (!resolved) {
			continue;
		}

		try {
			options = {
				...options,
				...loadConfig(resolved, seen, configDirectory)
			};
		} catch {
			// Keep usable local options when an extended config is unreadable or malformed.
			seen.delete(process.platform === 'win32' ? resolved.toLowerCase() : resolved);
		}
	}

	const local = {
		...config.compilerOptions
	};
	for (const key of ['baseUrl', 'jsxFactory', 'jsxFragmentFactory'] as const) {
		if (local[key] !== undefined && typeof local[key] !== 'string') {
			delete local[key];
		}
	}

	for (const key of ['rootDirs', 'moduleSuffixes', 'customConditions'] as const) {
		if (local[key] !== undefined && (!Array.isArray(local[key]) || !local[key]!.every(value => typeof value === 'string'))) {
			delete local[key];
		}
	}

	const expand = (value: string): string => value.replaceAll('${configDir}', configDirectory);
	if (typeof local.baseUrl === 'string') {
		local.baseUrl = path.resolve(directory, expand(local.baseUrl));
	}

	if (local.paths && typeof local.paths === 'object') {
		local.paths = Object.fromEntries(Object.entries(local.paths).filter(([, values]) => Array.isArray(values) && values.every(value => typeof value === 'string')).map(([key, values]) => [key, values.map(expand)]));
		local.pathsBasePath = directory;
	} else {
		delete local.paths;
	}

	if (Array.isArray(local.rootDirs)) {
		local.rootDirs = local.rootDirs.map(value => path.resolve(directory, expand(value)));
	}

	seen.delete(key);

	return {
		...options,
		...local
	};
}

export function parseJsonConfig(text: string): unknown {
	return new JsonReader(text).read();
}

export function readFile(filename: string): string | undefined {
	try {
		return readFileSync(filename, 'utf8');
	} catch {
		return undefined;
	}
}

export function fileExists(filename: string): boolean {
	try {
		return statSync(filename).isFile();
	} catch {
		return false;
	}
}

export function readProjectConfig(filename: string): { options: CompilerOptions } | undefined {
	try {
		return {
			options: loadConfig(filename, new Set(), path.dirname(path.resolve(filename)))
		};
	} catch {
		return undefined;
	}
}
