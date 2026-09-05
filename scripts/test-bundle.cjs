const path          = require('node:path');
const { spawnSync } = require('node:child_process');

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'src/extension.test.ts'], {
	stdio: 'inherit',
	env:   {
		...process.env,
		IMPORT_AUTHORITY_TEST_BUNDLE: path.resolve('dist/extension.js'),
	},
});

if (result.error) {
	console.error(result.error);
}

process.exit(result.status ?? 1);
