// Run after yarn package: node benchmarks/startup.cjs <baseline-commit> [samples]
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync, statSync, copyFileSync } = require('node:fs');
const { tmpdir, cpus } = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const revision = process.argv[2];
const samples = Number(process.argv[3] ?? 15);
assert.ok(revision, 'Pass the baseline commit to compare.');
assert.ok(Number.isInteger(samples) && samples >= 3, 'Use at least three fresh-process samples.');

const temporary = mkdtempSync(path.join(tmpdir(), 'import-authority-startup-'));
const archive = path.join(temporary, 'source.tar');
writeFileSync(archive, execFileSync('git', ['archive', '--format=tar', revision, 'src']));
execFileSync('tar', ['-xf', archive, '-C', temporary]);
const baseline = path.join(temporary, 'baseline.cjs');
const candidate = path.join(temporary, 'candidate.cjs');
esbuild.buildSync({
	entryPoints: [path.join(temporary, 'src/extension.ts')],
	nodePaths: [path.resolve('node_modules')],
	outfile: baseline,
	bundle: true,
	minify: true,
	platform: 'node',
	format: 'cjs',
	external: ['vscode'],
});
copyFileSync(path.resolve('dist/extension.js'), candidate);

// Reuse the integration-test VS Code mock, with real CommonJS module loading.
// Compiling the harness happens here, outside the timed child processes.
let harness = readFileSync('src/extension.test.ts', 'utf8').split(/\r?\ntest\(/)[0];
harness = harness.replace("import ts from 'typescript';", '');
const start = harness.indexOf('\tconst filename     =');
const end = harness.indexOf('\tconst subscriptions = [] as vscode.Disposable[];');
assert.ok(start >= 0 && end > start, 'The test harness changed; update the startup benchmark adapter.');
harness = harness.slice(0, start) + `
	const filename = process.env.IMPORT_AUTHORITY_TEST_BUNDLE!;
	const Module = require('node:module');
	const load = Module._load;
	Module._load = function(name: string, parent: unknown, ...args: unknown[]) {
		if (name === 'vscode') {
			return api;
		}
		if (!Module.isBuiltin(name) && name !== filename) {
			throw new Error('Unexpected runtime dependency: ' + name);
		}
		return load.call(this, name, parent, ...args);
	};
	const loadStart = performance.now();
	const extension = { exports: require(filename) };
	const loadEnd = performance.now();
` + harness.slice(end);
harness = harness.replace('provider: provider!,', 'loadMs: loadEnd - loadStart, activateMs: performance.now() - loadEnd, provider: provider!,');
harness += `
async function measure() {
	const extension = activateTestExtension("import { B } from './b';\\nimport { A } from './a';\\nconst value: A = B;\\n");
	const first = performance.now();
	await extension.commands.get('import-authority.organizeImports')!();
	const firstOrganizeMs = performance.now() - first;
	assert.ok(extension.applied.length > 0);
	const warm = performance.now();
	await extension.commands.get('import-authority.organizeImports')!();
	const warmOrganizeMs = performance.now() - warm;
	extension.dispose();
	console.log(JSON.stringify({loadMs: extension.loadMs, activateMs: extension.activateMs, firstOrganizeMs, warmOrganizeMs}));
}
void measure();
`;
const harnessFile = path.join(temporary, 'measure.cjs');
writeFileSync(harnessFile, esbuild.transformSync(harness, { loader: 'ts', format: 'cjs', target: 'node24' }).code);

const measurements = { baseline: [], candidate: [] };
for (let iteration = 0; iteration < samples; iteration++) {
	for (const name of iteration % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
		const result = spawnSync(process.execPath, [harnessFile], {
			encoding: 'utf8',
			env: { ...process.env, IMPORT_AUTHORITY_TEST_BUNDLE: name === 'baseline' ? baseline : candidate },
			timeout: 30000,
		});
		assert.equal(result.status, 0, result.stderr || String(result.error));
		measurements[name].push(JSON.parse(result.stdout));
	}
}

const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = {};
for (const key of ['loadMs', 'activateMs', 'firstOrganizeMs', 'warmOrganizeMs', 'loadAndActivateMs']) {
	const value = entry => key === 'loadAndActivateMs' ? entry.loadMs + entry.activateMs : entry[key];
	const before = median(measurements.baseline.map(value));
	const after = median(measurements.candidate.map(value));
	summary[key] = { before, after, improvementPercent: (1 - after / before) * 100 };
}

console.log(JSON.stringify({
	revision,
	node: process.version,
	cpu: cpus()[0].model,
	samples,
	note: 'Fresh Node processes with a VS Code API mock; module loading is measured separately from activate().',
	bytes: { before: statSync(baseline).size, after: statSync(candidate).size },
	summary,
	measurements,
}, null, 2));
