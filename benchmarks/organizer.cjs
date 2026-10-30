// Run: node --import tsx benchmarks/organizer.cjs <baseline-commit>
const assert               = require('node:assert/strict');
const { execFileSync }     = require('node:child_process');
const { join, resolve }    = require('node:path');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir }           = require('node:os');
const { buildSync }        = require('esbuild');
const { performance }      = require('node:perf_hooks');
const ts                   = require('typescript');
const current              = require('../src/lib/organizer.ts');
const revision             = process.argv[2];
if (!revision) {
	throw new Error('Pass the baseline commit to compare.');
}

// Snapshot every runtime dependency so a refactor cannot mix old and new analyzers.
const snapshot = mkdtempSync(join(tmpdir(), 'import-authority-benchmark-'));
const archive = join(snapshot, 'source.tar');
writeFileSync(archive, execFileSync('git', ['archive', '--format=tar', revision, 'src']));
execFileSync('tar', ['-xf', archive, '-C', snapshot]);
const baselineFile = join(snapshot, 'organizer.cjs');
buildSync({
	entryPoints: [join(snapshot, 'src/lib/organizer.ts')],
	nodePaths: [resolve('node_modules')],
	outfile: baselineFile,
	bundle: true,
	platform: 'node',
	format: 'cjs',
});
const baseline = require(baselineFile);
/**
 * Exercise binding-index transitions against the previous implementation before
 * timing. A fixed seed makes failures reproducible without timing-based tests.
 */
let seed = 42;
const random = maximum => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;

	return (seed >>> 8) % maximum;
};

for (let sample = 0; sample < 100; sample++) {
	const imports = Array.from({
		length: 80
	}, (_, i) => `import Base${i} from 'module';`);

	for (let i = 0; i < 120; i++) {
		const name = `Binding${i}`;
		imports.push([
			`import ${name} from 'module';`,
			`import * as ${name} from 'module';`,
			`import { value as ${name} } from 'module';`,
			`import type ${name} from 'module';`,
			`import type * as ${name} from 'module';`,
			`import type { Value as ${name} } from 'module';`,
			`import ${name}, { value as Named${i} } from 'module';`,
			`import ${name}, * as Namespace${i} from 'module';`,
		][random(8)]);
	}

	const input   = imports.join('\n') + '\n';
	const options = {
		groupImports:    !!random(2),
		typeImportStyle: random(2) ? 'inline' : 'declaration'
	};
	assert.equal(current.organizeImportsContent(input, 'file.ts', options), baseline.organizeImportsContent(input, 'file.ts', options));
}

if (process.argv.includes('--verify-only')) {
	console.log('100 deterministic mixed-import comparisons passed.');
	process.exit(0);
}

console.log(JSON.stringify({
	baseline:   revision,
	node:       process.version,
	typescript: ts.version,
	cpu:        require('node:os').cpus()[0].model,
	warmups:    4,
	samples:    11
}));

const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

for (const count of [100, 1000, 5000]) {
	for (const scenario of ['distinct', 'blocks', 'defaults', 'types']) {
		const input = Array.from({
			length: count
		}, (_, i) => scenario === 'defaults'
			? `import Name${i} from 'module';`
			: `import { Name${i} } from 'module${i}';${scenario === 'blocks' ? `\nconsole.log(Name${i});` : ''}`
		).join('\n') + (scenario === 'types'
			? '\n' + Array.from({ length: count }, (_, i) => `let value${i}: Name${i};`).join('\n')
			: '\nconsole.log(Name0);\n');
		assert.equal(current.organizeImportsContent(input), baseline.organizeImportsContent(input));

		for (let i = 0; i < 4; i++) {
			baseline.organizeImportsContent(input);
			current.organizeImportsContent(input);
		}

		const times = [[], []];

		for (let i = 0; i < 11; i++) {
			for (const index of i % 2 ? [1, 0] : [0, 1]) {
				const start = performance.now();
				(index === 0 ? baseline : current).organizeImportsContent(input);
				times[index].push(performance.now() - start);
			}
		}

		const [before, after] = times.map(median);
		console.log(JSON.stringify({
			scenario,
			count,
			beforeMs:           +before.toFixed(2),
			afterMs:            +after.toFixed(2),
			improvementPercent: +((1 - after / before) * 100).toFixed(1)
		}));
	}
}
