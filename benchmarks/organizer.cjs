// Run: node --import tsx benchmarks/organizer.cjs <baseline-commit>
const assert               = require('node:assert/strict');
const { execFileSync }     = require('node:child_process');
const { createRequire }    = require('node:module');
const { resolve }          = require('node:path');
const { performance }      = require('node:perf_hooks');
const { runInThisContext } = require('node:vm');
const ts                   = require('typescript');
const current              = require('../src/lib/organizer.ts');
const revision             = process.argv[2];
if (!revision) {
	throw new Error('Pass the baseline commit to compare.');
}

const source = execFileSync('git', ['show', `${revision}:src/lib/organizer.ts`], {
	encoding: 'utf8'
});
const compiled = ts.transpileModule(source, {
	compilerOptions: {
		module:          ts.ModuleKind.CommonJS,
		target:          ts.ScriptTarget.ES2022,
		esModuleInterop: true
	}
}).outputText;
const baselineModule = {
	exports: {}
};
runInThisContext(`(function(require,module,exports){${compiled}\n})`)(
	createRequire(resolve('src/lib/organizer.ts')), baselineModule, baselineModule.exports,
);

const baseline = baselineModule.exports;
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
	for (const scenario of ['distinct', 'blocks', 'defaults']) {
		const input = Array.from({
			length: count
		}, (_, i) => scenario === 'defaults'
			? `import Name${i} from 'module';`
			: `import { Name${i} } from 'module${i}';${scenario === 'blocks' ? `\nconsole.log(Name${i});` : ''}`
		).join('\n') + '\nconsole.log(Name0);\n';
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
