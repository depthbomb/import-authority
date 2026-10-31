// Run with node --import tsx scripts/test-corpus.cjs <source-directory> [...].
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const current = require('../src/lib/organizer.ts');
const { parseSource } = require('../src/lib/syntax/index.ts');
const { loadBaseline, revision } = require('./compatibility-baseline.cjs');
const baseline = loadBaseline();
const directories = process.argv.slice(2);
assert.ok(directories.length, 'Pass at least one source directory.');
const failures = [];
const shardCount = Number(process.env.IMPORT_AUTHORITY_CORPUS_SHARDS ?? 1);
const shardIndex = Number(process.env.IMPORT_AUTHORITY_CORPUS_SHARD ?? 0);
assert.ok(Number.isInteger(shardCount) && shardCount > 0);
assert.ok(Number.isInteger(shardIndex) && shardIndex >= 0 && shardIndex < shardCount);
const counts = { files: 0, valid: 0, invalid: 0, imports: 0, namespaceEligible: 0, namespace: 0 };
let discovered = 0;
let completed = false;
const reportDirectory = process.env.IMPORT_AUTHORITY_REPORT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'import-authority-corpus-results-'));
fs.mkdirSync(reportDirectory, { recursive: true });
const report = path.join(reportDirectory, `corpus-${shardIndex}.json`);

function saveReport() {
	fs.writeFileSync(report, JSON.stringify({ revision, shardIndex, shardCount, discovered, completed, counts, failures }, (_key, value) => value instanceof Set ? [...value] : value, 2));
}

function walk(directory) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
		if (entry.isSymbolicLink() || ['node_modules', '.git'].includes(entry.name)) continue;
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			walk(file);
			continue;
		}
		if (!/\.(?:[cm]?[jt]sx?|vue)$/.test(file)) continue;
		if (discovered++ % shardCount !== shardIndex) continue;
		const content = fs.readFileSync(file, 'utf8');
		if (process.env.IMPORT_AUTHORITY_CORPUS_TRACE) console.error(file);
		counts.files++;
		if (counts.files % 100 === 0) {
			saveReport();
			console.error(JSON.stringify({ progress: counts, failures: failures.length }));
		}
		try {
			if (!file.endsWith('.vue')) {
				const compiler = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
				if (compiler.parseDiagnostics.length) {
					counts.invalid++;
				} else {
					counts.valid++;
					assert.deepEqual(parseSource(file, content).parseDiagnostics, [], 'valid syntax rejected');
				}
			}
			if (!/\bimport\b/.test(content)) continue;
			counts.imports++;
			for (const options of [{}, { groupImports: true, quoteStyle: 'double', typeImportStyle: 'inline' }]) {
				assert.deepEqual(current.organizeImportsWithReport(content, file, options), baseline.organizeImportsWithReport(content, file, options), 'organization/report differs');
			}
			assert.deepEqual(current.getImportFixes(content, file), baseline.getImportFixes(content, file), 'quick fixes differ');
			assert.equal(current.removeUnusedImportsByScan(content, file), baseline.removeUnusedImportsByScan(content, file), 'fallback removal differs');
			if (/import\s+\*\s+as\b/.test(content)) {
				counts.namespaceEligible++;
				counts.namespace++;
				assert.deepEqual(current.getNamespaceImportFixes(content, file), baseline.getNamespaceImportFixes(content, file), 'namespace fixes/reasons differ');
			}
		} catch (error) {
			failures.push({ file, message: error.message, actual: error.actual, expected: error.expected });
			saveReport();
			console.error(`${file}: ${error.message.split('\n')[0]}`);
		}
	}
}

try {
	directories.forEach(directory => walk(path.resolve(directory)));
	assert.ok(counts.files, 'The selected corpus shard contains no source files.');
	completed = true;
} finally {
	saveReport();
}
console.log(JSON.stringify({ revision, shardIndex, shardCount, discovered, counts, failures: failures.length, report }));
if (failures.length) {
	console.error(failures.map(({ file, message }) => `${file}: ${message.split('\n')[0]}`).join('\n'));
	process.exitCode = 1;
}
