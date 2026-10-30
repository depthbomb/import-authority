const esbuild = require("esbuild");

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
				if (location) {
					console.error(`    ${location.file}:${location.line}:${location.column}:`);
				}
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints:    [
			'src/extension.ts'
		],
		bundle:         true,
		metafile:       true,
		format:         'cjs',
		minify:         production,
		sourcemap:      !production,
		sourcesContent: false,
		platform:       'node',
		outfile:        'dist/extension.js',
		external:       ['vscode'],
		logLevel:       'silent',
		plugins:        [
			{
				name: 'standalone-runtime',
				setup(build) {
					build.onResolve({
						filter: /^(?:typescript|typescript\/.*)$/
					}, args => ({
						errors: [{
							text: `TypeScript is a development dependency and cannot be bundled: ${args.path}`
						}],
					}));
					build.onEnd(result => {
						const dependencies = Object.keys(result.metafile?.inputs ?? {}).filter(file => /(?:^|\/)node_modules\//.test(file));
						if (dependencies.length) {
							return {
								errors: [{
									text: `The extension runtime must remain dependency-free: ${dependencies.join(', ')}`
								}]
							};
						}
					});
				},
			},
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
