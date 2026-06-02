/**
 * CUDA (.cu/.cuh) end-to-end parsing — worker path + parity (PR #1879 follow-up).
 *
 * The original CUDA PR wired the tree-sitter-cuda grammar into parser-loader.ts
 * (the sequential / secondary-processor path) but NOT into the parse-worker,
 * which runs the *primary* batch symbol extraction. As a result CUDA files were
 * detected as C++ and parsed with tree-sitter-cpp in the worker, never with the
 * CUDA grammar (review Finding 1, "CRITICAL").
 *
 * This test pins the fix: running the CUDA fixture through BOTH the worker pool
 * and the sequential path must
 *   (a) extract the CUDA kernel / device / host functions as symbols, and
 *   (b) produce identical Function definitions in both modes.
 *
 * Requires the compiled worker (`dist/.../parse-worker.js`); the integration
 * runner builds it via `pretest:integration`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  runPipelineFromRepo,
  getNodesByLabel,
  type PipelineResult,
} from './resolvers/helpers.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'cuda');

// tree-sitter-cuda is an optionalDependency. When it is genuinely installed the
// CUDA grammar parses `<<<...>>>` kernel launches and emits the launch CALLS
// edge; when it is absent `.cu`/`.cuh` fall back to tree-sitter-cpp, where the
// launch is an ERROR node and that specific edge is lost (by design). Detect
// availability so the kernel-launch assertion skips rather than fails on hosts
// without a prebuilt — the symbol-extraction and worker/sequential parity
// assertions below hold under the fallback either way.
const cudaGrammarInstalled = (() => {
  try {
    createRequire(import.meta.url)('tree-sitter-cuda');
    return true;
  } catch {
    return false;
  }
})();

const EXPECTED_FUNCTIONS = ['launchVectorAdd', 'scaleKernel', 'square', 'vectorAdd'];

const runMode = (mode: 'worker' | 'sequential'): Promise<PipelineResult> =>
  runPipelineFromRepo(FIXTURE, () => {}, {
    skipGraphPhases: true,
    // Force the worker-pool gate low so the 2-file fixture engages the pool.
    workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
    ...(mode === 'worker' ? { workerPoolSize: 2 } : { skipWorkers: true }),
  });

describe('CUDA (.cu/.cuh) parsing', () => {
  let worker: PipelineResult;
  let sequential: PipelineResult;

  beforeAll(async () => {
    worker = await runMode('worker');
    sequential = await runMode('sequential');
  }, 120_000);

  it('worker mode genuinely used the pool (guards against silent sequential fallback)', () => {
    expect(worker.usedWorkerPool).toBe(true);
    expect(sequential.usedWorkerPool).toBe(false);
  });

  it('extracts CUDA kernel/device/host functions in the worker (primary) path', () => {
    const fns = getNodesByLabel(worker, 'Function');
    // This is the assertion the original PR could not make: the worker, not
    // just the sequential secondary processors, surfaces CUDA functions.
    expect(fns).toEqual(expect.arrayContaining(EXPECTED_FUNCTIONS));
  });

  it('produces identical Function definitions in worker and sequential modes', () => {
    expect(getNodesByLabel(worker, 'Function')).toEqual(getNodesByLabel(sequential, 'Function'));
  });

  it.skipIf(!cudaGrammarInstalled)('resolves the host → kernel call (vectorAdd<<<...>>>) as a CALLS edge', () => {
    // The `<<<grid, block>>>` launch parses cleanly under the CUDA grammar, so
    // the call extractor sees launchVectorAdd → vectorAdd. Under a plain C++
    // grammar the `<<<` would be a parse error and this edge could be lost —
    // hence this assertion is skipped when tree-sitter-cuda isn't installed.
    const calls = new Set<string>();
    for (const rel of worker.graph.iterRelationships()) {
      if (rel.type !== 'CALLS') continue;
      const src = worker.graph.getNode(rel.sourceId)?.properties.name;
      const tgt = worker.graph.getNode(rel.targetId)?.properties.name;
      if (src && tgt) calls.add(`${src} → ${tgt}`);
    }
    expect([...calls]).toContain('launchVectorAdd → vectorAdd');
  });
});
