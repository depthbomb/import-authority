const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { buildSync } = require('esbuild');

const revision = 'f38c54992fb91cda0b962ecf8b510aab478d0cc7';
const compilerVersion = '6.0.3';
const root = path.resolve(__dirname, '..');
let snapshot;
const bundles = new Map();

function baselineBundle(entry = 'src/lib/organizer.ts') {
	assert.equal(require('typescript').version, compilerVersion, 'The release oracle must use TypeScript 6.0.3; do not silently update the compatibility baseline.');
	if (!snapshot) {
		snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'import-authority-baseline-'));
		const archive = path.join(snapshot, 'source.tar');
		fs.writeFileSync(archive, execFileSync('git', ['archive', '--format=tar', revision, 'src'], {
			cwd: root
		}));
		execFileSync('tar', ['-xf', archive, '-C', snapshot]);
	}

	if (!bundles.has(entry)) {
		const filename = path.join(snapshot, `baseline-${bundles.size}.cjs`);
		buildSync({
			entryPoints: [path.join(snapshot, entry)],
			nodePaths: [path.join(root, 'node_modules')],
			outfile: filename,
			bundle: true,
			platform: 'node',
			format: 'cjs',
			external: ['vscode'],
		});
		bundles.set(entry, filename);
	}

	return bundles.get(entry);
}

module.exports = {
	revision,
	compilerVersion,
	baselineBundle,
	loadBaseline: () => require(baselineBundle()),
};
