import path from 'node:path';
import { fileExists, readFile } from './project-config';
import type { CompilerOptions } from './project-config';
import { parseSource, resolveReference, isImportDeclaration } from './syntax';
import type { Binding, SourceFile } from './syntax';
import { matchesLanguageVersion } from './syntax/version';
import { patternMatch, matchedKey, packageTargets } from './package-map';

export type ResolutionContext = {
	compilerOptions?: CompilerOptions;
	readFile?:        (filename: string) => string | undefined;
	fileExists?:      (filename: string) => boolean;
	directoryExists?: (directory: string) => boolean;
};
export type ResolvedExport = { source: SourceFile; binding?: Binding; name: string };
type PackageJson = {
	name?:          string;
	type?:          string;
	types?:         string;
	typings?:       string;
	main?:          string;
	exports?:       unknown;
	imports?:       unknown;
	typesVersions?: Record<string, Record<string, string[]>>;
};

export class ModuleResolver {
	private readonly options: CompilerOptions;
	private readonly sources = new Map<string, SourceFile | undefined>();
	private readonly resolutions = new Map<string, string | undefined>();
	private readonly manifests = new Map<string, PackageJson | undefined>();
	private readonly ambientModules = new Map<string, string>();
	private indexed = false;
	private indexing = false;
	private readonly root: SourceFile;
	private readonly read: (filename: string) => string | undefined;
	private readonly exists: (filename: string) => boolean;

	public constructor(source: SourceFile, context: ResolutionContext) {
		this.root = source;
		this.options = {
			...context.compilerOptions
		};
		for (const key of ['module', 'moduleResolution'] as const) {
			const value = this.options[key];
			if (typeof value === 'string') {
				this.options[key] = value.toLowerCase();
			}
		}
		this.read = context.readFile ?? readFile;
		this.exists = context.fileExists ?? fileExists;
		this.sources.set(path.resolve(source.fileName), source);
	}

	public source(filename: string): SourceFile | undefined {
		const file = path.resolve(filename);
		if (!this.sources.has(file)) {
			const text = this.read(file);
			this.sources.set(file, text === undefined ? undefined : parseSource(file, text));
		}

		return this.sources.get(file);
	}

	public resolve(specifier: string, containingFile: string): string | undefined {
		const key = `${containingFile}\0${specifier}`;
		if (!this.resolutions.has(key)) {
			this.resolutions.set(key, undefined);
			this.resolutions.set(key, this.resolveModule(specifier, containingFile));
		}

		const resolved = this.resolutions.get(key);
		if (!resolved && !this.indexing) {
			this.indexAmbientModules();
		}

		const ambient = matchedKey([...this.ambientModules.keys()], specifier);

		return resolved ?? (ambient ? this.ambientModules.get(ambient) : undefined);
	}

	public exported(filename: string, name: string, visited = new Set<string>()): ResolvedExport | undefined {
		const key = `${filename}\0${name}`;
		if (visited.has(key)) {
			return undefined;
		}

		visited.add(key);
		const source = this.source(filename);
		if (!source || source.parseDiagnostics.length || source.exportEquals) {
			return undefined;
		}

		for (const entry of source.exports.filter(entry => entry.exported === name)) {
			if (entry.commonJs && resolveReference(entry.commonJs)) {
				continue;
			}

			if (entry.module) {
				const target = this.resolve(entry.module, entry.source?.fileName ?? source.fileName);
				if (target) {
					return entry.namespace ? {
						source,
						name
					} : this.exported(target, entry.imported ?? name, new Set(visited));
				}
			} else if (entry.local || entry.binding) {
				const binding = entry.binding ?? (entry.scope ?? source.scope).bindings.get(entry.local!)?.[0];
				if (binding?.import && binding.import.imported !== '*') {
					const target = this.resolve(binding.import.module, entry.source?.fileName ?? source.fileName);

					return target ? this.exported(target, binding.import.imported, new Set(visited)) : undefined;
				}

				return binding ? {
					source: entry.source ?? source,
					binding,
					name
				} : undefined;
			} else {
				return {
					source,
					name
				};
			}
		}

		let result: ResolvedExport | undefined;
		for (const entry of source.exports.filter(entry => entry.exported === '*' && entry.module && name !== 'default')) {
			const target    = this.resolve(entry.module!, entry.source?.fileName ?? source.fileName);
			const candidate = target && this.exported(target, name, new Set(visited));
			if (candidate) {
				if (result && (result.source !== candidate.source || result.binding !== candidate.binding)) {
					return undefined;
				}

				result = candidate;
			}
		}

		return result;
	}

	private indexAmbientModules(): void {
		if (this.indexed || this.indexing) {
			return;
		}

		this.indexing = true;
		const pending = [this.root];
		const visited = new Set<string>();
		while (pending.length) {
			const source = pending.pop()!;
			if (visited.has(source.fileName) || source.parseDiagnostics.length) {
				continue;
			}

			visited.add(source.fileName);
			for (const [name, scope] of source.ambientModules) {
				if (name === 'global') {
					continue;
				}

				const filename = this.ambientModules.get(name) ?? `${source.fileName}.ambient.${encodeURIComponent(name)}.ts`;
				const existing = this.sources.get(filename);
				const entries = (scope.exports ?? []).map(entry => ({
					...entry,
					source
				}));
				this.sources.set(filename, {
					...source,
					scope,
					exports: [...existing?.exports ?? [], ...entries],
					exportEquals: !!scope.exportEquals
				});
				this.ambientModules.set(name, filename);
			}

			const dependencies = source.statements.filter(isImportDeclaration).map(statement => statement.moduleSpecifier.text);
			dependencies.push(...source.exports.flatMap(entry => entry.module ? [entry.module] : []));
			for (const comment of source.comments) {
				const reference = /^\/\/\/\s*<reference\s+(path|types)\s*=\s*(['"])(.*?)\2/.exec(source.text.slice(comment.pos, comment.end));
				if (reference) {
					dependencies.push(reference[1] === 'path' ? path.resolve(path.dirname(source.fileName), reference[3]) : `@types/${reference[3].replace(/^@/, '').replace('/', '__')}`);
				}
			}

			for (const dependency of dependencies) {
				const target = this.resolve(dependency, source.fileName);
				const loaded = target && this.source(target);
				if (loaded) {
					pending.push(loaded);
				}
			}
		}

		this.indexed = true;
		this.indexing = false;
	}

	private manifest(directory: string): PackageJson | undefined {
		if (!this.manifests.has(directory)) {
			try {
				const text = this.read(path.join(directory, 'package.json'));
				this.manifests.set(directory, text === undefined ? undefined : JSON.parse(text));
			} catch {
				this.manifests.set(directory, undefined);
			}
		}

		return this.manifests.get(directory);
	}

	private file(candidate: string, typesOnly = false): string | undefined {
		const extension = path.extname(candidate);
		const stem      = candidate.slice(0, -extension.length || undefined);
		const extensions: Record<string, string[]> = {
			'.js':  ['.ts', '.tsx', '.d.ts', '.js', '.jsx'],
			'.jsx': ['.tsx', '.d.ts', '.jsx'],
			'.mjs': ['.mts', '.d.mts', '.mjs'],
			'.cjs': ['.cts', '.d.cts', '.cjs'],
		};
		const candidates = extensions[extension]?.map(ext => stem + ext)
			?? (extension && /\.[cm]?tsx?$/.test(extension) ? [candidate]
				: [candidate + '.ts', candidate + '.tsx', candidate + '.d.ts', candidate + '.js', candidate + '.jsx', candidate]);
		for (const file of candidates) {
			if (typesOnly && !/\.[cm]?tsx?$/.test(file)) {
				continue;
			}

			const ext  = /\.d\.[cm]?ts$/.exec(file)?.[0] ?? path.extname(file);
			const base = file.slice(0, -ext.length || undefined);
			for (const suffix of this.options.moduleSuffixes ?? ['']) {
				const suffixed = `${base}${suffix}${ext}`;
				if (this.exists(suffixed)) {
					return path.resolve(suffixed);
				}
			}
		}

		return undefined;
	}

	private candidate(candidate: string, directories = true, typesOnly = false): string | undefined {
		const file = this.file(candidate, typesOnly);
		if (file || !directories) {
			return file;
		}

		const manifest = this.manifest(candidate);
		for (const field of [manifest?.types, manifest?.typings, manifest?.main]) {
			if (typeof field === 'string') {
				const resolved = this.file(path.resolve(candidate, field), typesOnly);
				if (resolved) {
					return resolved;
				}
			}
		}

		return this.file(path.join(candidate, 'index'), typesOnly);
	}

	private conditions(containingFile: string): Set<string> {
		let mode = /\.[cm][jt]s$/.test(containingFile) ? (path.extname(containingFile)[1] === 'm' ? 'import' : 'require') : '';
		for (let directory = path.dirname(containingFile); !mode; directory = path.dirname(directory)) {
			const manifest = this.manifest(directory);
			if (manifest || path.dirname(directory) === directory) {
				mode = manifest?.type === 'module' ? 'import' : 'require';
			}
		}

		if (this.options.moduleResolution === 'bundler' || this.options.moduleResolution === 100) {
			mode = this.options.module === 'commonjs' || this.options.module === 1 ? 'require' : 'import';
		}

		const bundler = this.options.moduleResolution === 'bundler' || this.options.moduleResolution === 100;

		return new Set(['types', ...bundler ? [] : ['node'], mode, 'default', ...this.options.customConditions ?? []]);
	}

	private packageMap(map: unknown, key: string, directory: string, containingFile: string, imports = false, typesOnly = false): string | undefined {
		for (const substituted of packageTargets(map, key, this.conditions(containingFile))) {
			if (substituted.startsWith('./')) {
				const candidate = path.resolve(directory, substituted);
				const relative  = path.relative(directory, candidate);
				if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).includes('node_modules')) {
					continue;
				}

				const resolved = this.candidate(candidate, false, typesOnly);
				if (resolved) {
					return resolved;
				}
			} else if (imports && !substituted.startsWith('#')) {
				const resolved = this.resolve(substituted, containingFile);
				if (resolved) {
					return resolved;
				}
			}
		}

		return undefined;
	}

	private packageMapsEnabled(imports = false): boolean {
		const explicit = imports ? this.options.resolvePackageJsonImports : this.options.resolvePackageJsonExports;

		return explicit ?? !['classic', 'node', 'node10', 1, 2].includes(this.options.moduleResolution ?? 'nodenext');
	}

	private versionedPackage(directory: string, segments: string[], manifest: PackageJson | undefined, typesOnly: boolean): string | undefined {
		const versioned = Object.entries(manifest?.typesVersions ?? {}).find(([version]) => matchesLanguageVersion(version))?.[1];
		if (versioned && typeof versioned === 'object') {
			const entry = segments.length ? segments.join('/') : manifest?.types ?? manifest?.typings ?? 'index.d.ts';
			const key   = matchedKey(Object.keys(versioned), entry);
			if (key && Array.isArray(versioned[key])) {
				for (const target of versioned[key]) {
					if (typeof target === 'string') {
						const resolved = this.candidate(path.resolve(directory, target.replace('*', patternMatch(key, entry)!)), true, typesOnly);
						if (resolved) {
							return resolved;
						}
					}
				}

				return undefined;
			}
		}

		return this.candidate(path.join(directory, ...segments), true, typesOnly);
	}

	private resolveModule(specifier: string, containingFile: string): string | undefined {
		const directory = path.dirname(path.resolve(containingFile));
		if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
			const candidate = path.resolve(directory, specifier);
			const resolved  = this.candidate(candidate);
			if (resolved) {
				return resolved;
			}

			for (const root of this.options.rootDirs ?? []) {
				const relative = path.relative(root, candidate);
				if (relative.startsWith('..') || path.isAbsolute(relative)) {
					continue;
				}

				for (const other of this.options.rootDirs ?? []) {
					const resolved = this.candidate(path.join(other, relative));
					if (resolved) {
						return resolved;
					}
				}
			}

			return undefined;
		}

		const aliases = this.options.paths ?? {};
		const matched = matchedKey(Object.keys(aliases), specifier);
		if (matched) {
			for (const target of aliases[matched]) {
				const resolved = this.candidate(path.resolve(this.options.baseUrl ?? this.options.pathsBasePath ?? directory, target.replace('*', patternMatch(matched, specifier)!)));
				if (resolved) {
					return resolved;
				}
			}
		}

		if (this.options.baseUrl) {
			const resolved = this.candidate(path.resolve(this.options.baseUrl, specifier));
			if (resolved) {
				return resolved;
			}
		}

		if (this.options.moduleResolution === 'classic' || this.options.moduleResolution === 1) {
			for (const typesOnly of [true, false]) {
				for (let current = directory; ; current = path.dirname(current)) {
					const resolved = this.file(path.join(current, specifier), typesOnly);
					if (resolved) {
						return resolved;
					}

					if (path.dirname(current) === current) {
						break;
					}
				}
			}

			return this.resolvePackage(`@types/${specifier.replace(/^@/, '').replace('/', '__')}`, containingFile, true);
		}

		return this.resolvePackage(specifier, containingFile, true) ?? this.resolvePackage(specifier, containingFile, false);
	}

	private resolvePackage(specifier: string, containingFile: string, typesOnly: boolean): string | undefined {
		const directory   = path.dirname(path.resolve(containingFile));
		const segments    = specifier.split('/');
		const packageName = segments.splice(0, specifier.startsWith('@') ? 2 : 1).join('/');
		const subpath     = segments.length ? `./${segments.join('/')}` : '.';
		for (let current = directory; ; current = path.dirname(current)) {
			const own = this.manifest(current);
			if (specifier.startsWith('#') && own) {
				return this.packageMapsEnabled(true) ? this.packageMap(own.imports, specifier, current, containingFile, true, typesOnly) : undefined;
			}

			if (own?.name === packageName && own.exports !== undefined && this.packageMapsEnabled()) {
				return this.packageMap(own.exports, subpath, current, containingFile, false, typesOnly);
			}

			const root     = path.join(current, 'node_modules', packageName);
			const manifest = this.manifest(root);
			const resolved = manifest?.exports !== undefined && this.packageMapsEnabled()
				? this.packageMap(manifest.exports, subpath, root, containingFile, false, typesOnly)
				: this.versionedPackage(root, segments, manifest, typesOnly);
			if (resolved) {
				return resolved;
			}

			const typesPackage  = packageName.startsWith('@') ? packageName.slice(1).replace('/', '__') : packageName;
			const typesRoot     = path.join(current, 'node_modules', '@types', typesPackage);
			const typesManifest = this.manifest(typesRoot);
			const types = typesManifest?.exports !== undefined && this.packageMapsEnabled()
				? this.packageMap(typesManifest.exports, subpath, typesRoot, containingFile, false, typesOnly)
				: this.versionedPackage(typesRoot, segments, typesManifest, typesOnly);
			if (types) {
				return types;
			}

			if (path.dirname(current) === current) {
				return undefined;
			}
		}
	}
}
