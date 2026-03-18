import { defineConfig } from 'tsdown';

export default defineConfig((options) => ({
	clean: true,
	entry: [
		'src/extension.ts',
	],
	exports: {
		packageJson: false,
	},
	format: 'cjs',
	dts: false,
	minify: true,
	deps: {
		neverBundle: ['vscode'],
		skipNodeModulesBundle: true,
	},
	splitting: true,
	sourcemap: false,
	target: 'esnext',
	tsconfig: './tsconfig.json',
	watch: options.watch,
	keepNames: false
}));
