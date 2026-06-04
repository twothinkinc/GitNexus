# Spec: CUDA (`.cu`/`.cuh`) indexing for GitNexus

**Status:** Implemented on branch `feat/cuda-support` (twothinkinc fork).
**Commits:** `4399ccfa` (feature + refactor + tests), `07814185` (build DX), docs follow-ups.
**Methodology:** superpowers brainstorming → writing-plans → TDD with hypothesis-driven
adversarial tests → per-slice review gates (`thermo-nuclear-code-quality-review` +
superpowers `requesting-code-review`).

---

## 1. Problem

GitNexus classified `.cu` (CUDA translation units) and `.cuh` (device headers) as
unsupported. They were ingested as empty `File` nodes with **zero extracted
symbols**, so code intelligence (impact, query, context, call graph) was blind to
the kernel/device/host logic that dominates GPU codebases (e.g. GPUMD).

Upstream PR [#1879](https://github.com/abhigyanpatwari/GitNexus/pull/1879) attempted
this but a production-readiness review found **three blocking defects**:

1. **CRITICAL — primary path bypassed the CUDA grammar.** The parallel worker
   (`parse-worker.ts`) used `tree-sitter-cpp` for `.cu`/`.cuh`. The CUDA grammar was
   only wired into secondary processors, so the headline benefit was actually just
   "detected as C++", not real CUDA parsing.
2. **HIGH — unsafe version range.** `tree-sitter-cuda: ^0.20.5` could float to
   `0.21.x`, which peers `tree-sitter@^0.22.4` and pulls ABI-incompatible
   `tree-sitter-c@0.24.1` + `tree-sitter-cpp@0.23.4`, re-introducing the Windows
   segfault class of [#1242](https://github.com/abhigyanpatwari/GitNexus/issues/1242).
3. **HIGH — contradictory fallback contract.** Logs/docs said "unparsed File nodes"
   while the code fell back to `tree-sitter-cpp`.

This fork must deliver CUDA support **without** any of those defects.

## 2. Goals

- `.cu`/`.cuh` indexed as first-class CUDA C++ in **both** ingestion paths (the
  parallel worker — primary batch symbol extraction — and the sequential path).
- Full symbol extraction: kernels (`__global__`), `__device__`/`__host__` functions,
  classes, structs, templates, namespaces.
- Call edges resolved: device calls, cross-file `#include`, **kernel launches**
  (`f<<<grid,block>>>(...)`), and cross-language **C++↔CUDA** calls.
- Graceful, **truthful** degradation to `tree-sitter-cpp` when `tree-sitter-cuda`
  is absent — files are never dropped; logs/docs match behavior.
- **Zero ABI regression** to existing C/C++ (and all other languages).

## 3. Non-Goals

- Publishing the fork to npm (license-gated; PolyForm Noncommercial).
- A CUDA-specific query/extractor grammar beyond what `tree-sitter-cuda` provides
  (we reuse the C++ provider's queries against the CUDA grammar).
- Indexing CUDA host/device *semantics* (memory spaces, launch config correctness).
- Corpus-mode evaluation wiring.

## 4. Requirements

### Functional
- **R1** `getLanguageFromFilename` maps `.cu`/`.cuh` → `CPlusPlus` (case-insensitive).
- **R2** A single source of truth (`grammarVariantKey`) routes `(language, path)` to a
  grammar key; `.cu`/`.cuh` → `<cpp>:cuda`, `.tsx` → `<ts>:tsx`, else the bare language.
  Used by the loader, the worker, and the C++ scope-resolution query so they cannot drift.
- **R3** Worker (primary path) parses `.cu`/`.cuh` with the CUDA grammar when installed.
- **R4** The C++ scope-resolution query is compiled against **the same grammar that
  parsed the tree** (CUDA for `.cu`/`.cuh`). (Root cause of CALLS edges — see R-T below.)
- **R5** The legacy call-resolution query cache is keyed by **grammar variant**, not
  bare language, so a mixed `.cpp`/`.cu` (or `.ts`/`.tsx`) batch never reuses one
  grammar's compiled query against another grammar's tree.

### Non-functional
- **R6 (ABI safety)** `tree-sitter-cuda` pinned **exactly** to `0.20.6`
  (optionalDependency); tracked in the `#858` readiness script with rationale.
- **R7 (fallback contract)** Absent grammar → parse via `tree-sitter-cpp`; never drop
  the file; loader logs an accurate message; worker degrades silently like other
  optional grammars; docs say exactly this.
- **R8 (no regression)** All existing C/C++, TS/JS, and parity suites stay green.

### Key technical invariant (R-T)
> **tree-sitter assigns node-type IDs per grammar instance.** A query compiled
> against grammar A, run on a tree parsed by grammar B, **silently matches nothing**
> (no error). Therefore every site that runs a C++ query against a CUDA-parsed tree
> must use a CUDA-compiled query. This is the load-bearing fact behind R2/R4/R5.

## 5. Acceptance Criteria

- **AC1** Indexing a repo with `.cu`/`.cuh` in normal source paths yields `Function`
  nodes for kernels/device/host fns (verified live: `saxpy`, `scale`, `runSaxpy`).
- **AC2** CALLS edges include `launchFn → kernel` (kernel launch), `kernel → deviceFn`,
  cross-file via `#include`, and `main(.cpp) → runSaxpy(.cuh)` (cross-language).
- **AC3** Worker mode and sequential mode produce identical `Function` defs (parity).
- **AC4** With `tree-sitter-cuda` unresolvable, `.cu` still parses via `tree-sitter-cpp`
  and `isLanguageAvailable(CPlusPlus,'x.cu')` is `true` (verified in a subprocess).
- **AC5** `tree-sitter-cuda` lockfile entry has **no** transitive `tree-sitter-c/cpp`;
  readiness `--assert-current` reports ABI 14 in range.
- **AC6** `tsc --noEmit` clean; CUDA + C++ + parity + TS/JS + cross-file-impl suites
  green (~889 tests across the touched surface); no new lint errors.

## 6. Methodology (how we built it)

### TDD (iron law)
No production code without a failing test first. Each slice: RED (failing test) →
verify it fails for the right reason → GREEN (minimal code) → verify → REFACTOR.

### Hypothesis-driven adversarial tests (quality over quantity)
For each slice, a subagent first **enumerates concrete hypotheses for how the code
could break**, ranks them by blast radius × likelihood, and writes the **few
highest-value** as the RED tests. We do not chase coverage percentage; we chase the
tests that would actually catch a real regression. Examples of the hypotheses that
became tests:
- "Uppercase `.CU` is detected as C++ but routed to plain C++ (case-sensitivity drift)."
- "Worker silently uses `tree-sitter-cpp` even when CUDA is installed (PR #1879's bug)."
- "A C++ query on a CUDA tree matches nothing, so `.cu` loses all CALLS edges."
- "A mixed `.cpp`+`.cu` batch reuses one grammar's cached query on the other → 0 matches."
- "`^0.20.x` floats to `0.21.x` and pulls ABI-incompatible `tree-sitter-c/cpp`."
- "Absent CUDA grammar throws / drops the file instead of falling back to C++."

### Per-slice review gates
After each slice goes green, **two reviews** run before moving on:
1. **`thermo-nuclear-code-quality-review`** — ambitious structural audit (code-judo,
   spaghetti/branch growth, 1k-line rule, boundary/abstraction quality).
2. superpowers **`requesting-code-review`** — fresh-context reviewer checks intent
   fit, correctness, and test quality; Critical/Important findings fixed before proceeding.

These gates are what surfaced the `grammarVariantKey` centralization (collapsing
triplicated routing) and the legacy query-cache variant-keying fix (R5) — both landed
as follow-up slices rather than shipping the first working version.

## 7. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| CUDA grammar ABI break vs `tree-sitter@0.21.1` | Exact pin `0.20.6`; readiness `--assert-current` gate |
| Cross-grammar 0-match silently drops edges | R2/R4/R5 single-source routing + parity + CALLS-edge tests |
| Vue/TS share the TS grammar object | Cache keyed by variant **string**, not grammar object |
| Optional grammar missing on a platform | C++ fallback (R7); subprocess fallback test (AC4) |
| Regression to existing C/C++ | Full C++/parity suites in the review gate (R8/AC6) |

## 8. Out of scope / follow-ups
- Publishing as `gitnexus-cuda` / `@twothinkinc/gitnexus` (license-gated).
- Adding `tree-sitter-cuda` to a future `tree-sitter@0.25` migration matrix
  (readiness script already tracks it).
