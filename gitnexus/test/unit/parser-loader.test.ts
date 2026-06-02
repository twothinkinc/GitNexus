import { describe, it, expect } from 'vitest';
import {
  loadParser,
  loadLanguage,
  resolveLanguageKey,
  isLanguageAvailable,
  getLanguageGrammar,
} from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

describe('parser-loader', () => {
  describe('loadParser', () => {
    it('returns a Parser instance', async () => {
      const parser = await loadParser();
      expect(parser).toBeDefined();
      expect(typeof parser.parse).toBe('function');
    });

    it('returns the same singleton instance', async () => {
      const parser1 = await loadParser();
      const parser2 = await loadParser();
      expect(parser1).toBe(parser2);
    });
  });

  describe('loadLanguage', () => {
    it('loads TypeScript language', async () => {
      await expect(loadLanguage(SupportedLanguages.TypeScript)).resolves.not.toThrow();
    });

    it('loads JavaScript language', async () => {
      await expect(loadLanguage(SupportedLanguages.JavaScript)).resolves.not.toThrow();
    });

    it('loads Python language', async () => {
      await expect(loadLanguage(SupportedLanguages.Python)).resolves.not.toThrow();
    });

    it('loads Java language', async () => {
      await expect(loadLanguage(SupportedLanguages.Java)).resolves.not.toThrow();
    });

    it('loads C language', async () => {
      await expect(loadLanguage(SupportedLanguages.C)).resolves.not.toThrow();
    });

    it('loads C++ language', async () => {
      await expect(loadLanguage(SupportedLanguages.CPlusPlus)).resolves.not.toThrow();
    });

    it('loads C# language', async () => {
      await expect(loadLanguage(SupportedLanguages.CSharp)).resolves.not.toThrow();
    });

    it('loads Go language', async () => {
      await expect(loadLanguage(SupportedLanguages.Go)).resolves.not.toThrow();
    });

    it('loads Rust language', async () => {
      await expect(loadLanguage(SupportedLanguages.Rust)).resolves.not.toThrow();
    });

    it('loads PHP language', async () => {
      await expect(loadLanguage(SupportedLanguages.PHP)).resolves.not.toThrow();
    });

    it('loads TSX grammar for .tsx files', async () => {
      // TSX uses a different grammar (TypeScript.tsx vs TypeScript.typescript)
      await expect(
        loadLanguage(SupportedLanguages.TypeScript, 'Component.tsx'),
      ).resolves.not.toThrow();
    });

    it('loads TS grammar for .ts files', async () => {
      await expect(loadLanguage(SupportedLanguages.TypeScript, 'utils.ts')).resolves.not.toThrow();
    });

    it('loads Ruby language', async () => {
      await expect(loadLanguage(SupportedLanguages.Ruby)).resolves.not.toThrow();
    });

    it('throws for unsupported language', async () => {
      await expect(loadLanguage('erlang' as SupportedLanguages)).rejects.toThrow(
        'Unsupported language',
      );
    });
  });

  // #1242: regression coverage for the Windows tree-sitter@0.21.1 + tree-sitter-c
  // ABI mismatch. setLanguage alone could pass while the first non-trivial
  // traversal/query produced "Cannot read properties of undefined (reading
  // '161')" inside unmarshalNode (or a native segfault under the worker).
  describe('C parser ABI compatibility (#1242)', () => {
    const C_SOURCE = `#include <stdio.h>
struct Foo { int a; int b; };
typedef struct Foo Bar;
static int helper(int x) { return x * 2; }
int add(int a, int b) { return a + b; }
int main(void) {
  Bar b = {1, 2};
  return add(b.a, helper(b.b));
}
`;

    it('parses a non-trivial C translation unit and walks the tree', async () => {
      const parser = await loadParser();
      await loadLanguage(SupportedLanguages.C);
      const tree = parser.parse(C_SOURCE);

      expect(tree.rootNode.type).toBe('translation_unit');

      let nodeCount = 0;
      const walk = (node: { type: string; children: any[] }): void => {
        nodeCount += 1;
        // Touching `.type` here is what triggered the original
        // unmarshalNode crash on incompatible ABIs.
        expect(typeof node.type).toBe('string');
        for (const child of node.children) walk(child);
      };
      walk(tree.rootNode as any);
      expect(nodeCount).toBeGreaterThan(20);
    });

    it('extracts function definitions and call expressions via a query', async () => {
      const Parser = (await import('tree-sitter')).default;
      const parser = await loadParser();
      await loadLanguage(SupportedLanguages.C);
      const tree = parser.parse(C_SOURCE);
      const language = parser.getLanguage();

      const query = new (Parser as any).Query(
        language,
        '(function_definition declarator: (function_declarator declarator: (identifier) @name)) ' +
          '(call_expression function: (identifier) @callee)',
      );
      const captures = query.captures(tree.rootNode);
      const names = captures.filter((c: any) => c.name === 'name').map((c: any) => c.node.text);
      const callees = captures.filter((c: any) => c.name === 'callee').map((c: any) => c.node.text);

      expect(names).toEqual(expect.arrayContaining(['helper', 'add', 'main']));
      expect(callees).toEqual(expect.arrayContaining(['add', 'helper']));
    });

    it('walks a TreeCursor without throwing (catches unmarshalNode regressions)', async () => {
      const parser = await loadParser();
      await loadLanguage(SupportedLanguages.C);
      const tree = parser.parse(C_SOURCE);
      const cursor = tree.walk();
      let visited = 0;
      const descend = (): void => {
        visited += 1;
        if (cursor.gotoFirstChild()) {
          do {
            descend();
          } while (cursor.gotoNextSibling());
          cursor.gotoParent();
        }
      };
      descend();
      expect(visited).toBeGreaterThan(20);
    });
  });

  // CUDA (.cu/.cuh) is a C++ variant routed to the tree-sitter-cuda grammar
  // (an optionalDependency on the ABI-safe 0.20.x line) with a tree-sitter-cpp
  // fallback. These tests prove the grammar is actually selected and exercised
  // for `.cu`/`.cuh` paths — not merely that a module loads.
  describe('CUDA grammar routing (.cu/.cuh)', () => {
    const CUDA_KEY = `${SupportedLanguages.CPlusPlus}:cuda`;

    it('routes .cu and .cuh paths to the cuda grammar key (case-insensitive)', () => {
      expect(resolveLanguageKey(SupportedLanguages.CPlusPlus, 'src/force.cu')).toBe(CUDA_KEY);
      expect(resolveLanguageKey(SupportedLanguages.CPlusPlus, 'src/nep.cuh')).toBe(CUDA_KEY);
      // Case-insensitive — matches getLanguageFromFilename so KERNEL.CU does
      // not silently fall through to the plain C++ grammar.
      expect(resolveLanguageKey(SupportedLanguages.CPlusPlus, 'KERNEL.CU')).toBe(CUDA_KEY);
      // Plain C++ files still resolve to the bare C++ key.
      expect(resolveLanguageKey(SupportedLanguages.CPlusPlus, 'main.cpp')).toBe(
        SupportedLanguages.CPlusPlus,
      );
    });

    it('reports .cu/.cuh as available (cuda grammar present, or C++ fallback)', () => {
      expect(isLanguageAvailable(SupportedLanguages.CPlusPlus, 'kernel.cu')).toBe(true);
      expect(isLanguageAvailable(SupportedLanguages.CPlusPlus, 'kernel.cuh')).toBe(true);
    });

    it('returns a grammar for .cu that parses CUDA-specific kernel-launch syntax', async () => {
      const Parser = (await import('tree-sitter')).default;
      const parser = new Parser();
      // getLanguageGrammar applies the same routing the worker/pipeline use.
      parser.setLanguage(getLanguageGrammar(SupportedLanguages.CPlusPlus, 'vecadd.cu') as never);

      const CUDA_SOURCE = `__global__ void addKernel(const float* a, float* out, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) out[i] = a[i];
}
void launch(const float* a, float* out, int n) {
  addKernel<<<(n + 255) / 256, 256>>>(a, out, n);
}
`;
      const tree = parser.parse(CUDA_SOURCE);
      expect(tree.rootNode.type).toBe('translation_unit');

      // Walk the tree and confirm CUDA kernel-launch syntax is parsed as a
      // first-class node rather than an ERROR (which is what tree-sitter-cpp
      // produces for `<<<...>>>`). This is the load-bearing assertion that the
      // cuda grammar — not the cpp fallback — is in effect when installed.
      let sawKernelCall = false;
      let sawError = false;
      const walk = (node: { type: string; namedChildren: any[] }): void => {
        if (node.type === 'cuda_kernel_call' || node.type.includes('kernel')) sawKernelCall = true;
        if (node.type === 'ERROR') sawError = true;
        for (const child of node.namedChildren) walk(child);
      };
      walk(tree.rootNode as never);
      expect(sawError).toBe(false);
      expect(sawKernelCall).toBe(true);

      // And the C++ provider's queries must compile + run against the cuda
      // grammar (it is a tree-sitter-cpp superset), extracting the kernel
      // function by name.
      const query = new (Parser as any).Query(
        parser.getLanguage(),
        '(function_definition declarator: (function_declarator declarator: (identifier) @name))',
      );
      const names = query
        .captures(tree.rootNode)
        .filter((c: any) => c.name === 'name')
        .map((c: any) => c.node.text);
      expect(names).toEqual(expect.arrayContaining(['addKernel', 'launch']));
    });

    it('loadLanguage resolves for .cu/.cuh without throwing', async () => {
      await expect(
        loadLanguage(SupportedLanguages.CPlusPlus, 'src/force.cu'),
      ).resolves.not.toThrow();
      await expect(
        loadLanguage(SupportedLanguages.CPlusPlus, 'src/nep.cuh'),
      ).resolves.not.toThrow();
    });
  });

  describe('Swift optional dependency', () => {
    it('loads Swift from the default optional dependency and parses source', async () => {
      const parser = await loadParser();
      await loadLanguage(SupportedLanguages.Swift);

      const tree = parser.parse('class Foo { func bar() {} }');

      expect(tree.rootNode.type).toBe('source_file');
      expect(tree.rootNode.namedChildCount).toBe(1);
    });
  });
});
