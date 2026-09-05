# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-09-05

### Added

- Dedicated `source.organizeImports.importAuthority` save action
- File, import, and region ignore directives, including pinned imports
- Organization reports with change counts and explanations for skipped work
- Automatic conversion of imports used only as types, enabled by default
- Live import diagnostics and targeted quick fixes, enabled by default
- Explicit namespace-to-named import conversion with reference updates and collision-safe aliases

### Changed

- Accelerated duplicate consolidation and edits across multiple import blocks
- Grouped Command Palette commands under Import Authority
- Added Marketplace categories, search keywords, and support links
- Pinned packaging tools and aligned API types with the minimum supported VS Code version
- Built and retained installable VSIX artifacts in CI, including bundled TypeScript licenses
- Validated the production bundle with the extension integration tests before packaging

### Fixed

- Preserved executable code, trailing comments, detached comments, and directive headers around imports
- Rejected invalid default, namespace, and type-only import merges
- Kept `from` alignment from modifying string literals and contextual binding names
- Preserved implicit JSX bindings during heuristic unused-import removal
- Preserved module evaluation when reorganizing inline type imports
- Requested resolved language-service unused-import actions
- Made relative-path normalization stable across repeated organization

## [0.3.0] - 2026-08-24

### Added

- Added Vue single-file component support for inline JavaScript, JSX, TypeScript, and TSX
  `<script>` and `<script setup>` blocks
- Added continuous integration for immutable installs, tests, production builds, and extension
  package validation

### Changed

- Preserved the relative evaluation order of bare and runtime-only imports
- Left files with syntax errors unchanged to avoid destructive edits while typing
- Resolved path aliases inherited through extended TypeScript and JavaScript configurations
- Ran behavioral tests before publishing and strengthened lint failures

### Fixed

- Preserved empty value imports, inline-only type imports, deferred imports, import comments,
  compiler directives, JSX pragmas, and JSDoc-only usages
- Prevented fallback unused-import removal from deleting Vue bindings referenced by templates
- Prevented range formatting from modifying content outside the requested selection
- Constructed preview URIs safely for filenames containing URI-reserved characters
- Aligned VS Code API types with the declared minimum engine so extension packaging succeeds

### Security

- Replaced obsolete watch tooling and refreshed vulnerable transitive development dependencies

## [0.2.5] - 2026-08-16

### Changed

- Reduced document updates to the smallest changed range
- Cached TypeScript and JavaScript config discovery and invalidated the cache when config files change
- Released preview content when its virtual document closes

### Fixed

- Preserved import attributes, string-named specifiers, and escaped module names while organizing
- Combined compatible default and named imports under the `always` duplicate policy
- Improved fallback unused-import detection for property and declaration names
- Ensured source actions organize their requested document instead of whichever editor is active
- Prevented asynchronous organization from overwriting document changes made while providers are running

## [0.2.4] - 2026-04-01

### Fixed

- Fixed an issue where organizing imports could remove detached file-header comments

## [0.2.3] - 2026-03-27

### Fixed

- Fixed non-import code being eliminated between two blocks of imports when organizing

## [0.2.2] - 2026-03-18

### Fixed

- Attempted to fix commands not working again

## [0.2.1] - 2026-03-18

### Fixed

- Attempted to fix commands not working

## [0.2.0] - 2026-03-18

### Changed

- Significantly reduced extension size

## [0.1.1] - 2026-03-18

### Fixed

- Improved organizing when imports are not at the very top of the file, such as if there is code
and/or whitespace before the first import

## [0.1.0] - 2026-03-18

### Added

- Initial release
