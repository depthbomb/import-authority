const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const projects = [
	{ name: 'vue-3.5.0', repository: 'https://github.com/vuejs/core.git', revision: '6402b984087dd48f1a11f444a225d4ac6b2b7b9e', directory: 'packages' },
	{ name: 'typescript-5.9.3', repository: 'https://github.com/microsoft/TypeScript.git', revision: 'c63de15a992d37f0d6cec03ac7631872838602cb', directory: 'src' },
];
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'import-authority-corpus-'));
const directories = [];
for (const project of projects) {
	const directory = path.join(temporary, project.name);
	const git = args => execFileSync('git', ['-c', 'core.longpaths=true', '-C', directory, ...args], { stdio: 'inherit' });
	fs.mkdirSync(directory);
	git(['init', '--quiet', '--initial-branch=master']);
	git(['remote', 'add', 'origin', project.repository]);
	git(['sparse-checkout', 'init', '--cone']);
	git(['sparse-checkout', 'set', project.directory]);
	git(['fetch', '--quiet', '--depth=1', 'origin', project.revision]);
	git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
	directories.push(path.join(directory, project.directory));
}
execFileSync(process.execPath, ['--import', 'tsx', path.join(__dirname, 'test-corpus.cjs'), ...directories], { stdio: 'inherit' });
