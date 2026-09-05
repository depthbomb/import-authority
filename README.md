# Import Authority

Opinionated import organizer for JavaScript, TypeScript, and Vue in VS Code.

**Get the extension [here](https://marketplace.visualstudio.com/items?itemName=CaprineLogic.import-authority)!**

## Commands

- `Organize Imports`: applies rules directly to the active document.
- `Preview Organized Imports`: opens a diff preview without modifying your file.
- `Explain Import Organization`: analyzes the active file and opens a report in the **Import Authority** output channel without modifying the file.
- `Convert Namespace Import to Named Imports`: converts an eligible namespace import and its member references. If several imports qualify, choose one from the picker.

Manual organization reports whether imports changed and explains skipped work. Save actions and formatting write reports to the output channel without success notifications. Preview titles include counts; detailed explanations are available in the output channel.

Reports distinguish syntax errors, ignore directives, missing supported Vue scripts, malformed Vue markup, unavailable or failing unused-import providers, and files that are already organized. When only some Vue script blocks can be organized, the report identifies the skipped work alongside the changes.

Counts describe declarations merged and declarations moved by the organizer after optional language-service edits. Movement counts compare positions after consolidation, within each editable import block. Removed bindings count distinct module/local-name pairs removed by unused-import processing, so merging duplicate declarations does not count as unused removal. Formatting-only changes can have zero counts.

## Behavior

When you run `Organize Imports`, the extension enforces these rules by default:

- Import declarations are sorted by full line length (ascending).
- Value imports used exclusively as types are converted to type imports before sorting and merging (enabled by default).
- Imports with a default or namespace (`* as`) binding are placed below plain named imports, then sorted by length.
- `import type ...` declarations are placed below non-type imports.
- Named imports are rewritten to a single line and sorted by name length.
- Mixed named imports like `{ A, type B }` are split into separate declarations.
- Duplicate imports from the same module are merged per value/type bucket.
- Import-adjacent leading comments are preserved and move with their import.
- Bare side-effect imports retain their relative evaluation order.
- Files with syntax errors are left unchanged to avoid destructive edits while typing.
- Vue single-file components organize supported inline `<script>` and `<script setup>` blocks without touching templates or styles.

## Ignore and pin directives

Place these comments on their own lines between top-level statements:

- `// import-authority-ignore-file`: leave the entire file unchanged.
- `// import-authority-ignore` or `// import-authority-pin`: leave the immediately following import unchanged and prevent other imports from moving or merging across it.
- `// import-authority-off` and `// import-authority-on`: leave a region unchanged. Regions can nest; an unmatched `off` protects the rest of the file.

Block comments such as `/* import-authority-pin */` also work. Directive comments must contain only the directive. In Vue, put directives inside inline script blocks; regions apply within that script, while `ignore-file` disables the entire component.

When directives are present, language-service unused-import removal is skipped because external providers do not understand these boundaries. If heuristic fallback removal is enabled, it can still remove unprotected imports in supported non-JSX JavaScript and TypeScript files.

## Settings

- `importAuthority.features.enableDiagnostics` (`true`): show live diagnostics and quick fixes for import organization in open files.
- `importAuthority.typeImports.convertTypeOnlyImports` (`true`): convert TypeScript import bindings used exclusively as types before organization.
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
- `importAuthority.style.typeImportStyle` (`declaration` | `inline`): type-only import declaration style. Inline style retains mixed value/type bindings; standalone type declarations remain erased.
- `importAuthority.style.namedImportsWrapThreshold` (`0`): wrap named imports to multiple lines when the unbroken line would exceed this length (`0` disables wrapping).
- `importAuthority.style.alignFromKeyword` (`false`): add spacing so `from` aligns across single-line imports.
- `importAuthority.style.normalizeRelativePaths` (`false`): normalize relative module paths and collapse trailing `/index`.
- `importAuthority.unusedImports.useBuiltInRemoval` (`false`): remove unused imports first using the language service, then apply organizer ordering.
- `importAuthority.unusedImports.useFallbackRemoval` (`false`): if provider-based unused-import removal fails or has no effect, run a heuristic scan fallback.
- `importAuthority.features.enableFormattingProvider` (`false`): enable document/range formatting support.

## Live diagnostics and quick fixes

Import Authority checks open files after a 300 ms pause in typing. Informational diagnostics identify type-only bindings, mergeable duplicate imports, and import blocks that differ from your settings. Use the lightbulb to convert a declaration's type-only bindings or organize the affected block, including merging its duplicates. Other blocks and executable code remain untouched.

Diagnostics respect ignore directives and syntax errors, and support inline Vue script blocks. They use local analysis without requesting unused-import removal from another extension. Editing a document or changing settings invalidates its previous fixes. Disable `features.enableDiagnostics` to turn off these diagnostics and quick fixes.

## Namespace-to-named conversion

Run **Convert Namespace Import to Named Imports**, or request a refactor on a namespace import. For example, `import * as utils from './utils.js'` and `utils.format(value)` can become `import { format } from './utils.js'` and `format(value)`.

This is an explicit refactor. It updates the selected import and its references, preserves comments and type-only/default bindings, and generates aliases when a new name would collide anywhere in the file, including nested scopes. Unsaved dependency documents and the nearest tsconfig/jsconfig are included in resolution.

Every referenced named export must resolve. Direct function calls and tagged templates also require an available function implementation without receiver dependencies; declaration-only signatures are insufficient. Namespace object uses, computed access, writes, optional member access, default interop, JSDoc references, implicit JSX factories, and unsupported syntax are skipped. Imports or references protected by directives are preserved. Vue components are excluded because their templates require Vue-specific reference analysis. The command explains why a conversion is unavailable.

## Automatic type imports

By default, this input:

```ts
import { Model, run } from 'pkg';
let value: Model;
run();
```

becomes:

```ts
import { run } from 'pkg';
import type { Model } from 'pkg';

let value: Model;
run();
```

Conversion uses TypeScript's local symbol binding to distinguish imported names from shadowed variables. It handles default and namespace imports, aliases, type queries, and explicit type exports. Bindings with runtime references or no references remain value imports. Mixed imports follow `style.typeImportStyle`; standalone type imports use erased declarations. Reports include the number of bindings converted.

Ignore and pin directives also protect imports from conversion. JavaScript and Vue files, files containing decorators or direct `eval` calls, and imports containing internal comments, attributes, or deferred imports are left unconverted. JSX factory bindings from the nearest tsconfig/jsconfig and leading `@jsx`/`@jsxFrag` comments are preserved. Vue, decorator, and eval skips appear in reports.

Converting the last value binding removes that declaration's runtime module dependency. If the module must execute for side effects, keep an explicit `import 'module';` or pin the import. Set `importAuthority.typeImports.convertTypeOnlyImports` to `false` to disable conversion.

## Source Organize Imports Integration

The extension registers `source.organizeImports.importAuthority`, which also appears in the general Organize Imports flow. To select Import Authority specifically on save, use:

```json
"editor.codeActionsOnSave": {
  "source.organizeImports": "never",
  "source.organizeImports.importAuthority": "explicit"
}
```

Use `"always"` instead of `"explicit"` to include automatic saves on focus or window changes. Other explicitly enabled organizer actions should be disabled if you want only Import Authority to organize imports.

## Supported files

- `.ts`, `.tsx`, `.mts`, `.cts`
- `.js`, `.jsx`, `.mjs`, `.cjs`
- `.vue` with inline JavaScript, JSX, TypeScript, or TSX script blocks

Vue scripts with `src` or an unsupported `lang` are left unchanged. Heuristic fallback unused-import removal is disabled for Vue because template references are not visible from the script AST; provider-based removal can still be supplied by the installed Vue language service.

## Development

```sh
yarn install
yarn test
```

Run `yarn lint` to lint `src` with Oxlint, or `yarn lint --fix` to apply available
fixes. Tests and production builds also run linting. Install the recommended Oxc
VS Code extension for editor diagnostics.

`.oxlintrc.json` preserves the previous `curly`, `eqeqeq`, and `no-throw-literal`
checks as errors and disables default correctness rules to keep the migration's
rule scope unchanged. The former import naming convention and semicolon rules
are no longer enforced because Oxlint has no built-in equivalents; see the
[Oxlint rule reference](https://oxc.rs/docs/guide/usage/linter/rules.html).

Heuristic unused-import removal also skips files containing JSX because JSX factories and fragment bindings may be supplied implicitly by compiler or build configuration.
