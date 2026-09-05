# Organizer performance validation

Run from the repository root with installed project dependencies:

```sh
node --import tsx benchmarks/organizer.cjs 4ffb2de
```

The harness loads the baseline directly from Git without modifying the checkout,
asserts identical output, warms both versions four times, alternates execution
order, and reports the median of eleven measurements. Timings include parsing
and organization. Small sub-millisecond differences are noisy; there are no CI
timing assertions.

Environment: Windows, Intel Core i7-9700K, Node 24.17.0, TypeScript 6.0.3.

## Batched import-block replacement

Baseline: `4ffb2de`. EOL detection now runs once, edits retain original offsets,
and unchanged slices and replacement text are joined once for the whole script.
Both sorting and heuristic removal use the same assembly path.

| Scenario | Imports | Before (ms) | After (ms) | Reduction |
| --- | ---: | ---: | ---: | ---: |
| Separate import/code blocks | 1,000 | 21.81 | 13.72 | 37.1% |
| Separate import/code blocks | 5,000 | 764.67 | 74.03 | 90.3% |
| One block, distinct modules | 5,000 | 40.82 | 42.79 | -4.8% |
| Default bindings from one module | 5,000 | 221.89 | 223.29 | -0.6% |

The original review profile attributed roughly 65% of samples to block rebuilding
and repeated EOL detection, plus 20% to garbage collection. The optimization
targets those costs; the single-block control cases are essentially unchanged.
Regression tests verify all executable statements and idempotence across 250
blocks for both sorting and pruning, in addition to comment and Vue coverage.

## Indexed duplicate matching

Baseline: `4df6667`. Run:

```sh
node --import tsx benchmarks/organizer.cjs 4df6667
node --import tsx benchmarks/organizer.cjs 4df6667 --verify-only
```

Buckets with at least 64 incompatible candidates switch to binding/shape indexes.
Source-ordered heaps retain the original earliest-compatible merge behavior and
discard obsolete entries after clause mutations. Index allocation is lazy so
ordinary files and small buckets retain the simpler path.

| Scenario | Imports | Before (ms) | After (ms) | Reduction |
| --- | ---: | ---: | ---: | ---: |
| Default bindings from one module | 1,000 | 15.24 | 10.05 | 34.0% |
| Default bindings from one module | 5,000 | 300.23 | 57.93 | 80.7% |
| One block, distinct modules | 5,000 | 43.87 | 47.66 | -8.6% |
| Separate import/code blocks | 5,000 | 91.25 | 83.46 | 8.5% |

An earlier measurement also showed a 78.4% reduction for 5,000 default bindings
(229.23 ms to 49.45 ms). Absolute timings vary with system load. The final
threshold avoids meaningful small-file overhead (100 default imports: 0.90 ms
to 0.96 ms).

The benchmark harness additionally verifies 100 deterministic mixed-import
fixtures against the preceding implementation, covering default, namespace,
named, and type clauses. Unit tests exercise source-order selection after
indexed candidates change shape and ensure type clauses remain separate.
