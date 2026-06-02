/**
 * Subprocess probe for the CUDA → C++ grammar fallback.
 *
 * Run via `node --import tsx` from `parser-loader-cuda-fallback.test.ts`. It
 * makes `tree-sitter-cuda` unresolvable (simulating the optionalDependency
 * being absent or its native binding failing to build), then asserts that
 * parser-loader transparently falls back to tree-sitter-cpp for `.cu`/`.cuh`
 * files — i.e. CUDA files are still parsed, never dropped.
 *
 * A fresh process is required because the loader caches grammar loads for the
 * lifetime of the process, so the in-process test suite (which loads the real
 * cuda grammar) cannot exercise the missing-grammar branch.
 *
 * Prints `CUDA_FALLBACK_OK` and exits 0 on success; throws otherwise.
 */
import Module from 'node:module';

// Intercept module loading so any `require('tree-sitter-cuda')` (the loader
// uses createRequire under the hood, which routes through Module._load) fails
// as if the package were not installed.
const moduleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === 'tree-sitter-cuda') {
    const err = new Error("Cannot find module 'tree-sitter-cuda' (simulated absence)");
    (err as NodeJS.ErrnoException).code = 'MODULE_NOT_FOUND';
    throw err;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const main = async (): Promise<void> => {
  const { SupportedLanguages } = await import('gitnexus-shared');
  const { getLanguageGrammar, isLanguageAvailable } = await import(
    '../../src/core/tree-sitter/parser-loader.ts'
  );
  const Parser = (await import('tree-sitter')).default;

  // Even with the cuda grammar unavailable, .cu/.cuh must report available
  // (they parse via the C++ fallback).
  if (!isLanguageAvailable(SupportedLanguages.CPlusPlus, 'kernel.cu')) {
    throw new Error('expected .cu to be available via C++ fallback');
  }

  const cudaGrammar = getLanguageGrammar(SupportedLanguages.CPlusPlus, 'kernel.cu');
  const cppGrammar = getLanguageGrammar(SupportedLanguages.CPlusPlus, 'main.cpp');
  // The fallback must return the *C++* grammar object, not throw "Unsupported".
  if (cudaGrammar !== cppGrammar) {
    throw new Error('expected .cu grammar to fall back to the tree-sitter-cpp grammar object');
  }

  // And that grammar must actually parse a CUDA source file (plain C++ subset
  // still yields symbols; kernel-launch syntax may degrade to ERROR nodes,
  // which is the documented fallback trade-off).
  const parser = new Parser();
  parser.setLanguage(cudaGrammar as never);
  const tree = parser.parse('__global__ void k(int* p) {}\nint host() { return 0; }\n');
  if (tree.rootNode.type !== 'translation_unit') {
    throw new Error(`unexpected root node: ${tree.rootNode.type}`);
  }

  process.stdout.write('CUDA_FALLBACK_OK\n');
};

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
