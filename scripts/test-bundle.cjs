const path          = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, copyFileSync } = require('node:fs');
const { tmpdir } = require('node:os');

// Exercise the shipped artifact outside the workspace's dependency tree.
const isolated = path.join(mkdtempSync(path.join(tmpdir(), 'import-authority-bundle-')), 'extension.cjs');
copyFileSync(path.resolve('dist/extension.js'), isolated);

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'src/extension.test.ts'], {
	stdio: 'inherit',
	env:   {
		...process.env,
		IMPORT_AUTHORITY_TEST_BUNDLE: isolated,
	},
});

if (result.error) {
	console.error(result.error);
}

process.exit(result.status ?? 1);
