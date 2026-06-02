/**
 * CUDA → C++ grammar fallback (Finding 4 / contract test).
 *
 * The parser-loader caches grammar loads for the lifetime of the process, and
 * the rest of the suite loads the *real* tree-sitter-cuda grammar — so the
 * "grammar absent" branch can only be exercised in a fresh process. This test
 * spawns `fallback-probe.ts` with `tree-sitter-cuda` made unresolvable and
 * asserts the loader degrades `.cu`/`.cuh` parsing to tree-sitter-cpp instead
 * of throwing or dropping the file.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.resolve(here, '..', 'helpers', 'cuda-fallback-probe.ts');

describe('parser-loader CUDA fallback', () => {
  it('falls back to tree-sitter-cpp when tree-sitter-cuda is unavailable', () => {
    // `--import tsx` lets the child run the TypeScript probe directly. Inherit
    // stderr so a probe failure surfaces its stack in the test output.
    const out = execFileSync(process.execPath, ['--import', 'tsx', PROBE], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 60_000,
    });
    expect(out).toContain('CUDA_FALLBACK_OK');
  });
});
