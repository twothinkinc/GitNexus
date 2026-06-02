/**
 * Language Detection — maps file paths to SupportedLanguages enum values.
 *
 * Shared between CLI (ingestion pipeline) and web (syntax highlighting).
 *
 * ADDING A NEW LANGUAGE:
 * 1. Add enum member to SupportedLanguages in languages.ts
 * 2. Add file extensions to EXTENSION_MAP below
 * 3. TypeScript will error if you miss either step (exhaustive Record)
 */

import { SupportedLanguages } from './languages.js';

/** Ruby extensionless filenames recognised as Ruby source */
const RUBY_EXTENSIONLESS_FILES = new Set([
  'Rakefile',
  'Gemfile',
  'Guardfile',
  'Vagrantfile',
  'Brewfile',
]);

/**
 * Exhaustive map: every SupportedLanguages member → its file extensions.
 *
 * If a new language is added to the enum without adding an entry here,
 * TypeScript emits a compile error: "Property 'NewLang' is missing in type..."
 */
const EXTENSION_MAP: Record<SupportedLanguages, readonly string[]> = {
  [SupportedLanguages.JavaScript]: ['.js', '.jsx', '.mjs', '.cjs'],
  [SupportedLanguages.TypeScript]: ['.ts', '.tsx', '.mts', '.cts'],
  [SupportedLanguages.Python]: ['.py'],
  [SupportedLanguages.Java]: ['.java'],
  [SupportedLanguages.C]: ['.c'],
  // `.cu`/`.cuh` are CUDA C++ translation units / device headers. They map to
  // CPlusPlus so the C++ provider, queries, and entry-point heuristics apply.
  // When `tree-sitter-cuda` (optionalDependency) is installed they are parsed
  // with the CUDA grammar (CUDA-specific node types like `<<<>>>` kernel
  // launches); otherwise they fall back to `tree-sitter-cpp`. See
  // `parser-loader.ts` (`resolveLanguageKey`) and `isCudaFilename` below.
  [SupportedLanguages.CPlusPlus]: [
    '.cpp',
    '.cc',
    '.cxx',
    '.h',
    '.hpp',
    '.hxx',
    '.hh',
    '.cu',
    '.cuh',
  ],
  [SupportedLanguages.CSharp]: ['.cs'],
  [SupportedLanguages.Go]: ['.go'],
  [SupportedLanguages.Ruby]: ['.rb', '.rake', '.gemspec'],
  [SupportedLanguages.Rust]: ['.rs'],
  [SupportedLanguages.PHP]: ['.php', '.phtml', '.php3', '.php4', '.php5', '.php8'],
  [SupportedLanguages.Kotlin]: ['.kt', '.kts'],
  [SupportedLanguages.Swift]: ['.swift'],
  [SupportedLanguages.Dart]: ['.dart'],
  [SupportedLanguages.Vue]: ['.vue'],
  [SupportedLanguages.Cobol]: ['.cbl', '.cob', '.cpy', '.cobol'],
} satisfies Record<SupportedLanguages, readonly string[]>; // Ensure exhaustiveness

/** Pre-built reverse lookup: extension → language (built once at module load). */
const extToLang = new Map<string, SupportedLanguages>();
for (const [lang, exts] of Object.entries(EXTENSION_MAP) as [
  SupportedLanguages,
  readonly string[],
][]) {
  for (const ext of exts) {
    extToLang.set(ext, lang);
  }
}

/**
 * Laravel Blade templates are source templates whose filename convention ends
 * in `.blade.php`.  They may contain PHP snippets, but the full file is not a
 * pure PHP translation unit and must not enter the generic PHP provider path.
 */
export const isBladeTemplateFilename = (filePath: string): boolean =>
  filePath.replace(/\\/g, '/').toLowerCase().endsWith('.blade.php');

/**
 * CUDA source files (`.cu` device/host translation units, `.cuh` device
 * headers). These detect as {@link SupportedLanguages.CPlusPlus} but route to
 * the dedicated `tree-sitter-cuda` grammar variant when it is installed.
 *
 * This is the single source of truth for "is this path CUDA?" — both the
 * main-thread parser-loader (`resolveLanguageKey`) and the parse-worker's
 * private grammar router call it, so the two paths can never disagree about
 * routing (notably: the comparison is case-insensitive, matching
 * `getLanguageFromFilename`, so `kernel.CU` routes identically to `kernel.cu`).
 */
export const isCudaFilename = (filePath: string): boolean => {
  const p = filePath.toLowerCase();
  return p.endsWith('.cu') || p.endsWith('.cuh');
};

/**
 * Grammar-variant suffixes for the two languages that keep more than one
 * tree-sitter grammar under a single {@link SupportedLanguages} value.
 */
export const GRAMMAR_VARIANT_TSX = 'tsx';
export const GRAMMAR_VARIANT_CUDA = 'cuda';

/**
 * Resolve a (language, filePath) pair to the grammar-table key used to select a
 * tree-sitter grammar. Most languages map to their bare `SupportedLanguages`
 * value; the two that ship a second grammar under one language pick a
 * `"<lang>:<variant>"` key:
 *   - TypeScript `.tsx`      → `"<ts>:tsx"`   (tree-sitter-typescript `.tsx`)
 *   - C++ `.cu` / `.cuh`     → `"<cpp>:cuda"` (tree-sitter-cuda)
 *
 * This is the single source of truth for that decision, shared by the
 * main-thread parser loader (`parser-loader.ts`), the parse worker's private
 * grammar table, and the C++ scope-resolution query — so they can never drift
 * on routing. It is a pure function with no native dependencies, which is what
 * lets the worker import it (the worker cannot import the loader, whose grammar
 * table eagerly resolves native bindings).
 *
 * Matching is case-insensitive for both variants, consistent with
 * {@link getLanguageFromFilename} (which lowercases extensions) — so `Kernel.CU`
 * and `Component.TSX` route to their variant grammars rather than silently
 * falling through to the base grammar.
 */
export const grammarVariantKey = (language: SupportedLanguages, filePath?: string): string => {
  const lower = filePath?.toLowerCase();
  if (language === SupportedLanguages.TypeScript && lower?.endsWith('.tsx')) {
    return `${language}:${GRAMMAR_VARIANT_TSX}`;
  }
  if (language === SupportedLanguages.CPlusPlus && lower && isCudaFilename(lower)) {
    return `${language}:${GRAMMAR_VARIANT_CUDA}`;
  }
  return language;
};

/**
 * Map file extension to SupportedLanguage enum.
 * Returns null if the file extension is not recognized.
 */
export const getLanguageFromFilename = (filename: string): SupportedLanguages | null => {
  if (isBladeTemplateFilename(filename)) return null;

  // Fast path: check the extension map
  const lastDot = filename.lastIndexOf('.');
  if (lastDot >= 0) {
    const ext = filename.slice(lastDot).toLowerCase();
    const lang = extToLang.get(ext);
    if (lang !== undefined) return lang;
  }

  // Ruby extensionless files (Rakefile, Gemfile, etc.)
  const basename = filename.split('/').pop() || filename;
  if (RUBY_EXTENSIONLESS_FILES.has(basename)) {
    return SupportedLanguages.Ruby;
  }

  return null;
};

/**
 * Exhaustive map: every SupportedLanguages member → Prism syntax identifier.
 *
 * If a new language is added to the enum without adding an entry here,
 * TypeScript emits a compile error.
 */
const SYNTAX_MAP: Record<SupportedLanguages, string> = {
  [SupportedLanguages.JavaScript]: 'javascript',
  [SupportedLanguages.TypeScript]: 'typescript',
  [SupportedLanguages.Python]: 'python',
  [SupportedLanguages.Java]: 'java',
  [SupportedLanguages.C]: 'c',
  [SupportedLanguages.CPlusPlus]: 'cpp',
  [SupportedLanguages.CSharp]: 'csharp',
  [SupportedLanguages.Go]: 'go',
  [SupportedLanguages.Ruby]: 'ruby',
  [SupportedLanguages.Rust]: 'rust',
  [SupportedLanguages.PHP]: 'php',
  [SupportedLanguages.Kotlin]: 'kotlin',
  [SupportedLanguages.Swift]: 'swift',
  [SupportedLanguages.Dart]: 'dart',
  [SupportedLanguages.Vue]: 'typescript',
  [SupportedLanguages.Cobol]: 'cobol',
} satisfies Record<SupportedLanguages, string>; // Ensure exhaustiveness

/** Non-code file extensions → Prism-compatible syntax identifiers */
const AUXILIARY_SYNTAX_MAP: Record<string, string> = {
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  html: 'markup',
  htm: 'markup',
  erb: 'markup',
  xml: 'markup',
  css: 'css',
  scss: 'css',
  sass: 'css',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  toml: 'toml',
  ini: 'ini',
  dockerfile: 'docker',
};

/** Extensionless filenames → Prism-compatible syntax identifiers */
const AUXILIARY_BASENAME_MAP: Record<string, string> = {
  Makefile: 'makefile',
  Dockerfile: 'docker',
};

/**
 * Map file path to a Prism-compatible syntax highlight language string.
 * Covers all SupportedLanguages (code files) plus common non-code formats.
 * Returns 'text' for unrecognised files.
 */
export const getSyntaxLanguageFromFilename = (filePath: string): string => {
  if (isBladeTemplateFilename(filePath)) return 'markup';

  const lang = getLanguageFromFilename(filePath);
  if (lang) return SYNTAX_MAP[lang];
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext && ext in AUXILIARY_SYNTAX_MAP) return AUXILIARY_SYNTAX_MAP[ext];
  const basename = filePath.split('/').pop() || '';
  if (basename in AUXILIARY_BASENAME_MAP) return AUXILIARY_BASENAME_MAP[basename];
  return 'text';
};
