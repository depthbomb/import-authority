const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const { baselineBundle, revision } = require('./compatibility-baseline.cjs');

async function main() {
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'import-authority-host-'));
	const manifest = require('../package.json');
	// Supply the Vue language id without installing a third-party language server.
	manifest.contributes.languages = [{ id: 'vue', extensions: ['.vue'] }];
	const results = [];
	for (const variant of ['baseline', 'candidate']) {
		const extension = path.join(temporary, variant);
		const workspace = path.join(extension, 'workspace');
		fs.mkdirSync(path.join(extension, 'dist'), { recursive: true });
		fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
		fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify(manifest));
		fs.copyFileSync(variant === 'baseline' ? baselineBundle('src/extension.ts') : path.resolve('dist/extension.js'), path.join(extension, 'dist/extension.js'));
		fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify({
			'editor.defaultFormatter': 'CaprineLogic.import-authority',
			'editor.codeActionsOnSave': { 'source.organizeImports.importAuthority': 'explicit' },
			'importAuthority.features.enableFormattingProvider': true,
			'files.autoSave': 'off',
		}));
		const resultFile = path.join(extension, 'results.json');
		await runTests({
			version: process.argv[2] ?? 'stable',
			cachePath: path.join(os.tmpdir(), 'import-authority-vscode'),
			extensionDevelopmentPath: extension,
			extensionTestsPath: path.join(__dirname, 'host-suite.cjs'),
			extensionTestsEnv: { IMPORT_AUTHORITY_HOST_RESULTS: resultFile },
			launchArgs: [workspace, '--user-data-dir', path.join(extension, 'profile'), '--extensions-dir', path.join(extension, 'extensions'), '--disable-extensions', '--disable-extension=vscode.typescript-language-features', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--no-sandbox'],
		});
		results.push(JSON.parse(fs.readFileSync(resultFile, 'utf8')));
	}
	assert.deepEqual(results[1], results[0], 'Real extension-host behavior differs from the frozen release.');
	console.log(JSON.stringify({ baseline: revision, version: results[0].version, cases: Object.keys(results[0]).length - 1, results: temporary }));
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
