const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const requested = process.argv.slice(2);
const projects = require('./corpus-projects.cjs').filter(project => !requested.length || requested.includes(project.name));
assert.ok(projects.length && requested.every(name => projects.some(project => project.name === name)), 'Unknown corpus project.');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'import-authority-corpus-'));
const directories = [];
for (const project of projects) {
	const directory = path.join(temporary, project.name);
	const git = args => execFileSync('git', ['-c', 'core.longpaths=true', '-C', directory, ...args], { stdio: 'inherit' });
	fs.mkdirSync(directory);
	git(['init', '--quiet', '--initial-branch=master']);
	git(['remote', 'add', 'origin', project.repository]);
	git(['sparse-checkout', 'init', '--cone']);
	git(['sparse-checkout', 'set', ...project.directories]);
	git(['fetch', '--quiet', '--depth=1', 'origin', project.revision]);
	git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
	directories.push(...project.directories.map(source => path.join(directory, source)));
}
execFileSync(process.execPath, ['--import', 'tsx', path.join(__dirname, 'test-corpus.cjs'), ...directories], { stdio: 'inherit' });
