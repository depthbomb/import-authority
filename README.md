# Import Authority

Opinionated import organizer for JavaScript and TypeScript in VS Code.

**Get the extension [here](https://marketplace.visualstudio.com/items?itemName=CaprineLogic.import-authority)!**

## Commands

- `Organize Imports`: applies rules directly to the active document.
- `Preview Organized Imports`: opens a diff preview without modifying your file.

## Behavior

When you run `Organize Imports`, the extension enforces these rules by default:

- Import declarations are sorted by full line length (ascending).
- Imports with a default or namespace (`* as`) binding are placed below plain named imports, then sorted by length.
- `import type ...` declarations are placed below non-type imports.
- Named imports are rewritten to a single line and sorted by name length.
- Mixed named imports like `{ A, type B }` are split into separate declarations.
- Duplicate imports from the same module are merged per value/type bucket.
- Import-adjacent leading comments are preserved and move with their import.

## Settings

- `importAuthority.sorting.placeTypeImportsLast` (`true`): place type imports after non-type imports.
- `importAuthority.sorting.placeDefaultAndNamespaceImportsLast` (`true`): place default/namespace imports after plain named imports.
- `importAuthority.sorting.duplicateImportPolicy` (`always` | `namedOnly` | `never`): duplicate import consolidation strategy.
- `importAuthority.sorting.groupImports` (`false`): add blank lines between builtin/external/aliased/relative/type groups.
- `importAuthority.sorting.sideEffectPlacement` (`top` | `bottom`): side-effect import placement.
- `importAuthority.sorting.moduleSpecifierOrder` (`none` | `length` | `alpha`): optional secondary module-path ordering.
- `importAuthority.sorting.detectPathAliases` (`true`): detect aliases from nearest tsconfig/jsconfig `compilerOptions.paths`.
- `importAuthority.sorting.aliasPrefixes` (`[]`): extra alias prefixes for aliased-group classification.
- `importAuthority.style.semicolonPolicy` (`always` | `never` | `preserve`): add semicolons, remove semicolons, or keep existing semicolon state.
- `importAuthority.style.quoteStyle` (`single` | `double` | `preserve`): enforce quote style or keep the original quote style.
- `importAuthority.style.typeImportStyle` (`declaration` | `inline`): type-only import declaration style.
- `importAuthority.style.namedImportsWrapThreshold` (`0`): wrap named imports to multiple lines when the unbroken line would exceed this length (`0` disables wrapping).
- `importAuthority.style.alignFromKeyword` (`false`): add spacing so `from` aligns across single-line imports.
- `importAuthority.style.normalizeRelativePaths` (`false`): normalize relative module paths and collapse trailing `/index`.
- `importAuthority.unusedImports.useBuiltInRemoval` (`false`): remove unused imports first using the language service, then apply organizer ordering.
- `importAuthority.unusedImports.useFallbackRemoval` (`false`): if provider-based unused-import removal fails or has no effect, run a heuristic scan fallback.
- `importAuthority.features.enableFormattingProvider` (`false`): enable document/range formatting support.

## Source Organize Imports Integration

The extension registers a `source.organizeImports` code action so it appears in VS Code organize-import flows.

## Supported files

- `.ts`, `.tsx`, `.mts`, `.cts`
- `.js`, `.jsx`, `.mjs`, `.cjs`

## Development

```sh
yarn install
yarn test
```
