const esbuild = require("esbuild");
const fs      = require('node:fs/promises');
const path    = require('node:path');

const production = process.argv.includes('--production');
const watch      = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const typescriptDirectory = path.dirname(require.resolve('typescript/package.json'));
	const notices = await Promise.all(['LICENSE.txt', 'ThirdPartyNoticeText.txt'].map(filename => {
		return fs.readFile(path.join(typescriptDirectory, filename), 'utf8');
	}));
	await fs.mkdir('dist', {
		recursive: true
	});
	await fs.writeFile('dist/THIRD_PARTY_NOTICES.txt', `This extension bundles TypeScript (https://github.com/microsoft/TypeScript).\n\n${notices.join('\n\n')}`);

	const ctx = await esbuild.context({
		entryPoints:    [
			'src/extension.ts'
		],
		bundle:         true,
		format:         'cjs',
		minify:         production,
		sourcemap:      !production,
		sourcesContent: false,
		platform:       'node',
		outfile:        'dist/extension.js',
		external:       ['vscode'],
		logLevel:       'silent',
		plugins:        [
			// add to the end of plugins array
			esbuildProblemMatcherPlugin,
		],
	});

	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
