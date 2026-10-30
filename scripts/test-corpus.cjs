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
const namespaceLimit = Number(process.env.IMPORT_AUTHORITY_CORPUS_NAMESPACE_LIMIT ?? 32);
assert.ok(Number.isInteger(namespaceLimit) && namespaceLimit >= 0);
const counts = { files: 0, valid: 0, invalid: 0, imports: 0, namespaceEligible: 0, namespace: 0 };
let namespaceInProject = 0;

function walk(directory) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isSymbolicLink() || ['node_modules', '.git'].includes(entry.name)) continue;
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			walk(file);
			continue;
		}
		if (!/\.(?:[cm]?[jt]sx?|vue)$/.test(file)) continue;
		const content = fs.readFileSync(file, 'utf8');
		if (process.env.IMPORT_AUTHORITY_CORPUS_TRACE) console.error(file);
		counts.files++;
		if (counts.files % 100 === 0) console.error(JSON.stringify({ progress: counts, failures: failures.length }));
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
				// Each old namespace analysis builds the entire dependency graph again.
				// Bound that extra work; organization and quick fixes still cover every file.
				if (namespaceInProject >= namespaceLimit) continue;
				namespaceInProject++;
				counts.namespace++;
				assert.deepEqual(current.getNamespaceImportFixes(content, file), baseline.getNamespaceImportFixes(content, file), 'namespace fixes/reasons differ');
			}
		} catch (error) {
			failures.push({ file, message: error.message, actual: error.actual, expected: error.expected });
			console.error(`${file}: ${error.message.split('\n')[0]}`);
		}
	}
}

directories.forEach(directory => {
	namespaceInProject = 0;
	walk(path.resolve(directory));
});
const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'import-authority-corpus-results-')), 'results.json');
fs.writeFileSync(report, JSON.stringify({ revision, counts, failures }, (_key, value) => value instanceof Set ? [...value] : value, 2));
console.log(JSON.stringify({ revision, counts, failures: failures.length, report }));
if (failures.length) {
	console.error(failures.map(({ file, message }) => `${file}: ${message.split('\n')[0]}`).join('\n'));
	process.exitCode = 1;
}
