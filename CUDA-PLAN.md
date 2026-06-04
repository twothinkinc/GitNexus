# CUDA (`.cu`/`.cuh`) Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development
> (fresh subagent per task, two-stage review between tasks). Steps use checkbox syntax.
> **This plan is a retrospective record** of completed work on `feat/cuda-support`;
> boxes are checked `[x]` and each task cites where it landed. It doubles as a
> reproducible recipe.

**Goal:** Index CUDA `.cu`/`.cuh` as first-class CUDA C++ in both ingestion paths,
with a truthful `tree-sitter-cpp` fallback and zero ABI regression.

**Architecture:** `.cu`/`.cuh` detect as `CPlusPlus` and route — via one shared
`grammarVariantKey` helper — to a `<cpp>:cuda` grammar key backed by
`tree-sitter-cuda` (a `tree-sitter-cpp` superset). The loader, the parse worker, and
the C++ scope-resolution query all select the grammar from that key so they cannot
disagree; the legacy query cache is keyed by the same variant. Missing grammar →
fall back to `tree-sitter-cpp`.

**Tech Stack:** TypeScript, tree-sitter (`tree-sitter-cuda@0.20.6`, `tree-sitter-cpp`),
Vitest, LadybugDB. Node ≥ 22.

---

## Methodology (applies to every task)

**TDD (iron law):** no production code without a failing test first. RED → verify it
fails for the right reason → GREEN (minimal) → verify → REFACTOR.

**Hypothesis-driven adversarial RED (per slice):** before writing code, a subagent
enumerates concrete *failure hypotheses* ("how will this break?"), ranks by blast
radius × likelihood, and encodes the **few highest-value** as failing tests. Quality
over quantity — we want the tests that would catch a real regression, not coverage
theater. Each task below lists its hypotheses and the tests they became.

**Review gate (after each slice goes green):**
1. `thermo-nuclear-code-quality-review` — structural/code-judo audit.
2. superpowers `requesting-code-review` — fresh-context correctness + test-quality review.
Critical/Important findings are fixed before the next slice. (This gate produced
Tasks 1's `grammarVariantKey` centralization and Task 5's cache fix as follow-ups.)

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `gitnexus-shared/src/language-detection.ts` | extension→language; `isCudaFilename`; `grammarVariantKey` (single source of truth) | Modify |
| `gitnexus-shared/src/index.ts` | re-export the new helpers | Modify |
| `gitnexus/src/core/tree-sitter/parser-loader.ts` | grammar registry; `cpp:cuda` variant + `fallbackKey`; `resolveLanguageKey` = `grammarVariantKey` | Modify |
| `gitnexus/src/core/ingestion/workers/parse-worker.ts` | **primary** batch extraction; optional CUDA grammar; variant partition + C++ fallback | Modify |
| `gitnexus/src/core/ingestion/languages/cpp/query.ts` | C++ scope query/parser, grammar-matched per file | Modify |
| `gitnexus/src/core/ingestion/languages/cpp/captures.ts` | pass `filePath` so query grammar matches the tree | Modify |
| `gitnexus/src/core/ingestion/call-processor.ts` | legacy call resolution; variant-keyed query cache | Modify |
| `gitnexus/src/core/ingestion/pipeline-phases/cross-file-impl.ts` | owns the shared query-cache map | Modify |
| `gitnexus/src/core/ingestion/languages/c-cpp.ts` | `cppProvider.extensions` += `.cu`/`.cuh` | Modify |
| `gitnexus/src/core/ingestion/import-resolvers/utils.ts` | `.cu`/`.cuh` reachable as C/C++ includes | Modify |
| `gitnexus/package.json` | exact pin `tree-sitter-cuda@0.20.6` | Modify |
| `.github/scripts/check-tree-sitter-upgrade-readiness.py` | track the pin + ABI | Modify |
| `gitnexus/scripts/build.js` | `GITNEXUS_SKIP_WEB` gate (CLI/MCP-only installs) | Modify |
| `gitnexus/test/unit/parser-loader.test.ts` | CUDA routing + parse/walk/query | Modify |
| `gitnexus/test/unit/parser-loader-cuda-fallback.test.ts` | missing-grammar fallback (subprocess) | Create |
| `gitnexus/test/unit/parser-loader-abi.test.ts` | ABI smoke incl. `cpp:cuda` | Modify |
| `gitnexus/test/integration/cuda-parse.test.ts` | worker+sequential symbols, parity, launch edge | Create |
| `gitnexus/test/fixtures/cuda/{vecadd.cu,kernels.cuh}` | CUDA fixture | Create |
| `gitnexus/test/helpers/cuda-fallback-probe.ts` | subprocess probe for the fallback test | Create |
| `CUDA.md` | engineer-facing docs | Create |

---

## Task 1: Detection + single-source grammar routing

**Files:** Modify `gitnexus-shared/src/language-detection.ts`, `index.ts`;
Modify `gitnexus/src/core/ingestion/languages/c-cpp.ts`,
`import-resolvers/utils.ts`; Test `gitnexus/test/unit/parser-loader.test.ts`.

**Adversarial hypotheses → tests:**
- H1 `kernel.CU` (uppercase) detects as C++ but routes to plain C++ → wrong grammar.
- H2 `.cuh` collides with `.h` and is mis-detected.
- H3 routing logic duplicated across modules drifts (one fixed, others not).

- [x] **Step 1 — RED:** add to `parser-loader.test.ts` a `CUDA grammar routing` block:

```ts
const CUDA_KEY = `${SupportedLanguages.CPlusPlus}:cuda`;
it('routes .cu and .cuh paths to the cuda grammar key (case-insensitive)', () => {
  expect(resolveLanguageKey(SupportedLanguages.CPlusPlus, 'src/force.cu')).toBe(CUDA_KEY);
  expect(resolveLanguageKey(SupportedLanguages.CPlusPlus, 'src/nep.cuh')).toBe(CUDA_KEY);
  expect(resolveLanguageKey(SupportedLanguages.CPlusPlus, 'KERNEL.CU')).toBe(CUDA_KEY); // H1
  expect(resolveLanguageKey(SupportedLanguages.CPlusPlus, 'main.cpp')).toBe(
    SupportedLanguages.CPlusPlus,
  );
});
```

- [x] **Step 2 — Verify RED:** `npx vitest run test/unit/parser-loader.test.ts`
  → FAIL (`.cu` resolves to bare `CPlusPlus`; `KERNEL.CU` not routed).

- [x] **Step 3 — GREEN (minimal):** in `gitnexus-shared/src/language-detection.ts`
  add `.cu`/`.cuh` to the `CPlusPlus` `EXTENSION_MAP`, plus the shared helpers
  (single source of truth — answers H3):

```ts
export const isCudaFilename = (filePath: string): boolean => {
  const p = filePath.toLowerCase();
  return p.endsWith('.cu') || p.endsWith('.cuh');
};
export const GRAMMAR_VARIANT_TSX = 'tsx';
export const GRAMMAR_VARIANT_CUDA = 'cuda';
export const grammarVariantKey = (language, filePath?) => {
  const lower = filePath?.toLowerCase();
  if (language === SupportedLanguages.TypeScript && lower?.endsWith('.tsx'))
    return `${language}:${GRAMMAR_VARIANT_TSX}`;
  if (language === SupportedLanguages.CPlusPlus && lower && isCudaFilename(lower))
    return `${language}:${GRAMMAR_VARIANT_CUDA}`;
  return language;
};
```

  Export from `index.ts`; `parser-loader.resolveLanguageKey = grammarVariantKey`;
  add `.cu`/`.cuh` to `cppProvider.extensions` (c-cpp.ts) and to the import-resolver
  `EXTENSIONS` list. Rebuild `gitnexus-shared` (`npm run build`) — it's a `file:` dep.

- [x] **Step 4 — Verify GREEN:** rerun → PASS; uppercase + `.cuh` covered.

- [x] **Step 5 — Review gate + commit.** `thermo-nuclear` flagged the routing
  duplication (`resolveLanguageKey`/`workerLanguageKey`/`useCudaGrammar`); the
  `grammarVariantKey` single-source helper above is the resolution (code-judo:
  three copies → one). Landed in `4399ccfa`.

---

## Task 2: Grammar loading + truthful fallback (parser-loader)

**Files:** Modify `gitnexus/src/core/tree-sitter/parser-loader.ts`;
Modify `gitnexus/test/unit/parser-loader.test.ts`;
Create `gitnexus/test/unit/parser-loader-cuda-fallback.test.ts`,
`gitnexus/test/helpers/cuda-fallback-probe.ts`;
Modify `gitnexus/test/unit/parser-loader-abi.test.ts`.

**Adversarial hypotheses → tests:**
- H1 The CUDA grammar loads but the C++ query doesn't actually run against it
  (load-only "smoke" proves nothing) → parse + walk + run the real query.
- H2 Missing `tree-sitter-cuda` **throws** or marks `.cu` unavailable (dropped file)
  instead of falling back to C++.
- H3 `<<<...>>>` kernel launches degrade to `ERROR` even with the CUDA grammar.

- [x] **Step 1 — RED (H1/H3):** assert the grammar parses CUDA and the provider query
  captures the kernel (not a load-only smoke):

```ts
it('returns a grammar for .cu that parses CUDA-specific kernel-launch syntax', async () => {
  const parser = new Parser();
  parser.setLanguage(getLanguageGrammar(SupportedLanguages.CPlusPlus, 'vecadd.cu') as never);
  const tree = parser.parse('__global__ void addKernel(float* o){} \n void launch(int n){ addKernel<<<(n+255)/256,256>>>(o); }');
  // CUDA grammar parses the launch as real syntax, not ERROR:
  let sawError = false; const walk = (n) => { if (n.type==='ERROR') sawError=true; n.namedChildren.forEach(walk); };
  walk(tree.rootNode); expect(sawError).toBe(false);
  const q = new (Parser as any).Query(parser.getLanguage(),
    '(function_definition declarator: (function_declarator declarator: (identifier) @name))');
  const names = q.captures(tree.rootNode).filter(c=>c.name==='name').map(c=>c.node.text);
  expect(names).toEqual(expect.arrayContaining(['addKernel','launch']));
});
```

- [x] **Step 2 — RED (H2), subprocess:** the loader caches grammar loads for the
  process, so the "absent" branch needs a fresh process. Create
  `test/helpers/cuda-fallback-probe.ts` that patches `Module._load` to make
  `tree-sitter-cuda` throw `MODULE_NOT_FOUND`, then asserts
  `getLanguageGrammar(CPlusPlus,'kernel.cu') === getLanguageGrammar(CPlusPlus,'main.cpp')`
  (i.e. fell back to the **cpp** grammar object) and `isLanguageAvailable` is `true`.
  `parser-loader-cuda-fallback.test.ts` spawns it via `node --import tsx` and asserts
  `CUDA_FALLBACK_OK`.

- [x] **Step 3 — Verify RED:** both FAIL (no `cpp:cuda` source; no `fallbackKey`).

- [x] **Step 4 — GREEN:** add the `cpp:cuda` `GrammarSource`
  (`load: () => _require('tree-sitter-cuda')`, `optional: true`,
  `fallbackKey: CPlusPlus`, truthful `unavailableNote` saying "falls back to
  tree-sitter-cpp"); make `isLanguageAvailable`/`getLanguageGrammar` consult
  `fallbackKey`. Add a `cpp:cuda` row to `parser-loader-abi.test.ts` `SMOKE_CASES`.

- [x] **Step 5 — Verify GREEN:** CUDA unit + fallback subprocess + ABI smoke PASS.

- [x] **Step 6 — Review gate.** `requesting-code-review` confirmed the fallback is
  declarative (`fallbackKey`) and the note matches behavior (closes PR #1879 finding 3).
  Landed in `4399ccfa`.

---

## Task 3: Primary worker path (the PR #1879 CRITICAL fix)

**Files:** Modify `gitnexus/src/core/ingestion/workers/parse-worker.ts`;
Create `gitnexus/test/integration/cuda-parse.test.ts`, `test/fixtures/cuda/*`.

**Adversarial hypotheses → tests:**
- H1 The worker silently parses `.cu` with `tree-sitter-cpp` even when CUDA is
  installed (exactly PR #1879's defect) → assert the worker (not just sequential)
  extracts CUDA functions, and worker≡sequential parity.
- H2 Mixing `.cu` into the C++ file group breaks the per-language `setLanguage`.

- [x] **Step 1 — RED:** create fixture `test/fixtures/cuda/{vecadd.cu,kernels.cuh}`
  (a kernel, a `__device__` fn, a host launcher with `<<<...>>>`, a `#include`), and
  `cuda-parse.test.ts` running `runPipelineFromRepo` in **both** modes:

```ts
it('worker mode genuinely used the pool', () => {
  expect(worker.usedWorkerPool).toBe(true);
  expect(sequential.usedWorkerPool).toBe(false);
});
it('extracts CUDA kernel/device/host functions in the worker (primary) path', () => {
  expect(getNodesByLabel(worker, 'Function'))
    .toEqual(expect.arrayContaining(['launchVectorAdd','scaleKernel','square','vectorAdd']));
});
it('produces identical Function definitions in worker and sequential modes', () => {
  expect(getNodesByLabel(worker,'Function')).toEqual(getNodesByLabel(sequential,'Function'));
});
```

- [x] **Step 2 — Verify RED:** worker mode misses CUDA-specific extraction / parity
  diverges (worker uses CPP). FAIL.

- [x] **Step 3 — GREEN:** in `parse-worker.ts` add an optional `Cuda` require, register
  it under `CUDA_KEY` in `languageMap`, add `grammarForKey` (CUDA→CPP fallback), route
  `isLanguageAvailable`/`setLanguage` through `grammarVariantKey`, and partition the
  file group language-agnostically:
  `grammarVariantKey(language, f.path) !== language ? variantFiles : regularFiles`
  (subsumes the old TSX-only split — answers H2).

- [x] **Step 4 — Verify GREEN:** functions + parity PASS (worker now uses CUDA grammar).

- [x] **Step 5 — Review gate.** `thermo-nuclear` verified parse-worker.ts wasn't pushed
  past structural limits and the partition is the generic, not a special-case branch.
  Landed in `4399ccfa`.

---

## Task 4: CALLS-edge enablement — C++ scope query grammar parity

**Files:** Modify `gitnexus/src/core/ingestion/languages/cpp/query.ts`,
`cpp/captures.ts`; assert in `cuda-parse.test.ts`.

**Adversarial hypotheses → tests** (this slice was *driven* by a hypothesis the
debugging loop produced):
- H1 **A C++ query compiled against the CPP grammar, run on a CUDA-parsed tree,
  matches nothing — so `.cu` files get symbols but ZERO call edges** (even plain
  same-file calls). This is invariant R-T from the spec.

- [x] **Step 1 — RED:** add the cross-language + kernel-launch CALLS assertion to
  `cuda-parse.test.ts` (skipped when `tree-sitter-cuda` isn't installed):

```ts
it.skipIf(!cudaGrammarInstalled)('resolves the host → kernel call (vectorAdd<<<...>>>) as a CALLS edge', () => {
  const calls = new Set<string>();
  for (const rel of worker.graph.iterRelationships()) {
    if (rel.type !== 'CALLS') continue;
    const s = worker.graph.getNode(rel.sourceId)?.properties.name;
    const t = worker.graph.getNode(rel.targetId)?.properties.name;
    if (s && t) calls.add(`${s} → ${t}`);
  }
  expect([...calls]).toContain('launchVectorAdd → vectorAdd');
});
```

- [x] **Step 2 — Verify RED:** FAIL — CALLS empty for `.cu` (CPP-compiled scope query
  silently returns 0 matches on the CUDA tree; confirmed by isolating a plain `.cu`
  same-file call that resolves under `.cpp` but not `.cu`).

- [x] **Step 3 — GREEN:** in `cpp/query.ts` add an optional `CUDA` grammar +
  `useCudaGrammar(filePath)`; make `getCppParser(filePath?)` and
  `getCppScopeQuery(filePath?)` select and cache the CUDA parser/query for `.cu`/`.cuh`
  (mirroring the worker's grammar choice). In `captures.ts`, pass `filePath` into both.

- [x] **Step 4 — Verify GREEN:** CALLS now resolve — `runSaxpy → saxpy` (launch),
  `saxpy → scale` (device), cross-file `#include`, and `main(.cpp) → runSaxpy(.cuh)`
  (verified live via `gitnexus cypher`).

- [x] **Step 5 — Review gate.** Both reviews; `requesting-code-review` noted the same
  cross-grammar trap could exist elsewhere → Task 5. Landed in `4399ccfa`.

---

## Task 5: Mixed-batch query cache (review-driven follow-up)

**Files:** Modify `gitnexus/src/core/ingestion/call-processor.ts`,
`pipeline-phases/cross-file-impl.ts`; covered by `test/unit/cross-file-impl.test.ts`
+ worker/sequential parity.

**Adversarial hypotheses → tests:**
- H1 In a mixed `.cpp`+`.cu` chunk, the legacy `compiledQueryCache` (keyed by
  `SupportedLanguages`) hands a CPP-compiled query to a CUDA tree (or vice-versa) →
  silent 0 matches → dropped edges.
- H2 Keying the cache by the grammar **object** would be wrong: **Vue and TypeScript
  share the same `tree-sitter-typescript` grammar object** but have different query
  strings → collision. (Caught in review; the fix must key by variant **string**.)

- [x] **Step 1 — RED/known-state:** confirm `cross-file-impl.test.ts` pins that one
  shared cache map instance is passed to every `processCalls`; reason through H1/H2
  against the `call-processor.ts` cache site (`compiledQueryCache.get(language)`).

- [x] **Step 2 — GREEN:** key the cache by `grammarVariantKey(language, file.path)`
  (a string: `cpp` vs `cpp:cuda`, `typescript` vs `typescript:tsx`, and `vue` ≠
  `typescript`), widen the map type to `Map<string, Parser.Query>` in both files, and
  drop the now-unused `SupportedLanguages` import in `cross-file-impl.ts`.

- [x] **Step 3 — Verify GREEN:** `cross-file-impl.test.ts` + C++ + TS/JS + parity green
  (no Vue/TS collision, no cpp/cuda cross-contamination). Landed in `4399ccfa`.

- [x] **Step 4 — Review gate.** Closes the "is the invariant truly universal?" finding.

---

## Task 6: Dependency ABI safety (closes PR #1879 finding 2)

**Files:** Modify `gitnexus/package.json`,
`.github/scripts/check-tree-sitter-upgrade-readiness.py`.

**Adversarial hypotheses → guard:**
- H1 `^0.20.x` floats to `tree-sitter-cuda@0.21.x`, which peers `tree-sitter@^0.22.4`
  and pulls `tree-sitter-c@0.24.1` + `tree-sitter-cpp@0.23.4` → ABI segfault (#1242).

- [x] **Step 1 — Guard (RED-equivalent):** `python3 .github/scripts/check-tree-sitter-upgrade-readiness.py --assert-current`
  must report the CUDA grammar's ABI in range; the readiness matrix must name it.

- [x] **Step 2 — GREEN:** pin **exactly** `"tree-sitter-cuda": "0.20.6"` in
  `optionalDependencies` (no `^`); add `tree-sitter-cuda` to `GRAMMARS` and to
  `INTENTIONAL_PINS` (with the ABI rationale) in the readiness script.

- [x] **Step 3 — Verify:** `--assert-current` →
  `OK tree-sitter-cuda: installed ABI 14 in range [intentional pin: 0.20.6]`;
  lockfile shows no transitive `tree-sitter-c/cpp`. Landed in `4399ccfa`.

---

## Task 7: Build DX — `GITNEXUS_SKIP_WEB` (config slice)

**Files:** Modify `gitnexus/scripts/build.js`. *(Build-script config, not behavior —
verified by execution rather than a unit test; flagged per TDD "configuration" exception.)*

- [x] **Step 1:** Gate the `gitnexus-web` build behind `process.env.GITNEXUS_SKIP_WEB === '1'`
  (strict `1`, mirroring `GITNEXUS_SKIP_OPTIONAL_GRAMMARS`). Release/publish unset → unchanged.
- [x] **Step 2 — Verify:** `GITNEXUS_SKIP_WEB=1 node scripts/build.js` →
  `[build] skipping web UI (GITNEXUS_SKIP_WEB=1)` … `done`, exit 0; `dist/cli/index.js --version` works.
  Landed in `07814185`.

---

## Task 8: Docs

**Files:** Create `CUDA.md`.

- [x] Barebones engineer doc: what the fork does, Node ≥22 + `GITNEXUS_SKIP_WEB=1`
  build, `gitnexus-cuda` launcher, absolute-path MCP config (not `npx`/`setup`), and
  the optional-grammar/license notes. Landed in docs commits on the branch.

---

## Final verification (whole-plan)

- [x] `npx tsc --noEmit` clean.
- [x] CUDA suite: `parser-loader.test.ts`, `parser-loader-cuda-fallback.test.ts`,
  `parser-loader-abi.test.ts`, `cuda-parse.test.ts` — green.
- [x] No regression: `scope-resolution/cpp`, `resolvers/cpp.test.ts`,
  `c-cpp-typedef-legacy-parse.test.ts`, `worker-sequential-parity.test.ts`,
  `resolvers/{typescript,javascript}.test.ts`, `call-processor.test.ts`,
  `cross-file-impl.test.ts` — green (~889 tests across the touched surface).
- [x] Live end-to-end: indexed a CUDA sample; `cypher` shows kernels/device/host fns
  and the launch + cross-language CALLS edges.
- [x] No new lint errors on changed files.

## Self-Review (against the spec)

- **Spec coverage:** R1→T1, R2→T1, R3→T3, R4→T4, R5→T5, R6→T6, R7→T2, R8→Final.
  AC1–AC3→T3/T4, AC4→T2, AC5→T6, AC6→Final. No gaps.
- **Placeholders:** none — every task cites exact files, real test code, and where it landed.
- **Type/name consistency:** `grammarVariantKey`, `CUDA_KEY` (`cpp:cuda`), `fallbackKey`,
  `getCppScopeQuery(filePath)` used consistently across tasks.
