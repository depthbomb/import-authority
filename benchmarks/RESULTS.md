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
