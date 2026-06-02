<!-- version: 1.0.0 -->
<!-- Last updated: 2026-06-02 -->

# CUDA (`.cu` / `.cuh`) support — custom fork

This fork extends GitNexus to fully index **CUDA C++** sources. Before this
change, `.cu` and `.cuh` files were classified as unsupported and ingested as
empty `File` nodes (zero symbols), which blinded code intelligence for GPU
projects whose kernel/device logic lives in `.cu`/`.cuh`.

## Quick start (developers)

Copy-paste setup for the CLI + MCP (the browser UI is **not** needed and is
skipped). macOS/Linux:

```bash
# 1. Node >= 22 is a HARD requirement (Node 20 fails the build)
nvm install 22 && nvm use 22 && nvm alias default 22   # or any Node >= 22
node -v

# 2. Clone the fork
git clone https://github.com/twothinkinc/GitNexus.git
cd GitNexus

# 3. Build the shared package, then the CLI.
#    GITNEXUS_SKIP_WEB=1 skips the browser-UI build (Vite/rolldown) that CLI/MCP
#    users don't need. EXPORT it — `npm install`/`npm link`/`npm ci` all run the
#    build via the `prepare` script, and it fails on the web build without this.
cd gitnexus-shared && npm install && npm run build && cd ../gitnexus
export GITNEXUS_SKIP_WEB=1
npm install

# 4. Put `gitnexus` on your PATH. The build already produced an executable
#    dist/cli/index.js (with a shebang), so a symlink is the most reliable way:
ln -sf "$PWD/dist/cli/index.js" /opt/homebrew/bin/gitnexus   # macOS (Homebrew)
#   Linux: ln -sf "$PWD/dist/cli/index.js" ~/.local/bin/gitnexus   (dir must be on $PATH)
#   Alternative: `npm link`  (works only while GITNEXUS_SKIP_WEB=1 is exported)
gitnexus --version          # -> 1.6.5

# 5. Configure your editor's MCP (Cursor / Claude Code / Codex), then RESTART it
gitnexus setup

# 6. Index a repo — CUDA .cu/.cuh fully supported
cd /path/to/your/repo && gitnexus analyze
```

**If `npm install` / `npm link` errors with `@rolldown/binding-…` or a Vite
message:** you didn't `export GITNEXUS_SKIP_WEB=1` — that error is the browser UI
(`gitnexus-web`), which the CLI/MCP doesn't use. Set the flag and re-run.

**MCP config (manual, instead of `gitnexus setup`)** — editors spawn the command
directly, so point them at the linked `gitnexus` or the absolute path:

```json
{ "mcpServers": { "gitnexus": { "command": "node",
  "args": ["/ABS/PATH/TO/GitNexus/gitnexus/dist/cli/index.js", "mcp"] } } }
```

> One MCP server serves **all** repos you've `analyze`d — index more anytime and
> they appear automatically. Re-run `gitnexus analyze` to refresh a stale index.

The sections below cover the same steps in more depth, plus verification and the
implementation notes.

---

## What works now

`.cu` (translation units) and `.cuh` (device headers) are detected as C++ and
parsed with the dedicated [`tree-sitter-cuda`](https://github.com/tree-sitter-grammars/tree-sitter-cuda)
grammar in **both** ingestion paths (the parallel worker pool used for real
indexing **and** the sequential path), so they produce the full set of symbols
and relationships:

- **Definitions** — kernels (`__global__`), device/host functions
  (`__device__` / `__host__`), classes, structs, templates, namespaces.
- **Call edges**, including:
  - device calls inside a kernel (`kernel → deviceFn`),
  - cross-file calls through `#include "x.cuh"`,
  - **kernel launches** (`launchFn → kernel` from `kernel<<<grid, block>>>(...)`),
  - cross-language **C++ ↔ CUDA** calls (a `.cpp` caller → a `.cu`/`.cuh` callee).
- **Impact analysis / context / query / MCP tools** work on CUDA symbols.

### Graceful fallback

`tree-sitter-cuda` is an **optionalDependency**. If it is absent (or its native
binding fails to build), `.cu`/`.cuh` files **fall back to `tree-sitter-cpp`**
and are still parsed as C++ — they are never dropped. Only CUDA‑specific syntax
(notably `<<<...>>>` kernel launches) may not be recognized in that degraded
mode. The main-thread loader (`parser-loader.ts`, used by the sequential path
and secondary processors) logs a single, accurate diagnostic when it falls
back. The parallel **parse worker** degrades to `tree-sitter-cpp` *silently*,
consistent with every other optional grammar (Swift/Dart/Kotlin) — so a
worker-only run emits no CUDA-specific warning. Run with `--workers 0` (or the
sequential path) if you want the diagnostic surfaced.

### Why the version is pinned exactly

`gitnexus/package.json` pins `"tree-sitter-cuda": "0.20.6"` (exact, not `^`).
The `0.20.x` line peers `tree-sitter@^0.21.0` and has **no** transitive
`tree-sitter-c` / `tree-sitter-cpp` dependencies, so it is ABI‑compatible with
this repo's pinned `tree-sitter@0.21.1` runtime. `tree-sitter-cuda@0.21.x` peers
`tree-sitter@^0.22.4` and pulls ABI‑incompatible `tree-sitter-c@0.24.1` +
`tree-sitter-cpp@0.23.4`, which would re-introduce the Windows segfault class of
[#1242](https://github.com/abhigyanpatwari/GitNexus/issues/1242). The exact pin
prevents `npm install` / lockfile refresh from floating it forward. The pin is
tracked in `.github/scripts/check-tree-sitter-upgrade-readiness.py`.

---

## For engineers: install the fork, index, run the MCP

> Requirements: **Node ≥ 22** (hard requirement — the CLI's `engines` and the
> web toolchain both need it; Node 20 fails the build). Check with `node -v`,
> and if you use nvm: `nvm install 22 && nvm use 22 && nvm alias default 22`.
> A C/C++ toolchain (`python3`, `make`, `g++`) is only needed for grammars that
> compile from source — `tree-sitter-cuda` ships prebuilt binaries for Linux
> x64, macOS x64/arm64, and Windows x64, so most engineers won't need it.

### 1. Clone the fork and install (CLI + MCP only)

```bash
git clone https://github.com/twothinkinc/GitNexus.git
cd GitNexus

# Build the shared package first (it is a file: dependency of the CLI).
cd gitnexus-shared && npm install && npm run build && cd ..

# Skip the browser UI build (Vite/rolldown) that CLI/MCP users don't need.
# IMPORTANT: this flag must be set for EVERY npm lifecycle that runs the build —
# `npm install`, `npm link`, and `npm ci` all run the `prepare` script. The
# simplest way is to export it once for the whole setup session:
cd gitnexus
export GITNEXUS_SKIP_WEB=1

# Install + build the CLI (pulls tree-sitter-cuda@0.20.6, prebuilt) and link it.
npm install
npm link
gitnexus --version
```

> Why `export`? `npm link` (and `npm ci`) re-run `prepare` → the build. Without
> `GITNEXUS_SKIP_WEB=1` in the environment they fail on the web-UI build. If you
> didn't export it, prefix each command (`GITNEXUS_SKIP_WEB=1 npm link`) or, since
> `dist/` is already built, just `npm link --ignore-scripts`.
>
> Only building the browser UI? Leave `GITNEXUS_SKIP_WEB` unset (and ensure Node
> ≥ 22.12 + `gitnexus-web` deps). It is not needed for indexing or MCP.

If npm's optional-dependency resolution misbehaves (a known npm bug on some
platforms — see [npm/cli#4828](https://github.com/npm/cli/issues/4828)) and the
CUDA grammar (or any platform binding) is skipped, reinstall cleanly:

```bash
rm -rf node_modules package-lock.json && GITNEXUS_SKIP_WEB=1 npm install
# or, if peer resolution is the blocker:
GITNEXUS_SKIP_WEB=1 npm install --legacy-peer-deps
```

Verify the grammar installed and its ABI is in range:

```bash
node -e "require('tree-sitter-cuda'); console.log('tree-sitter-cuda OK')"
python3 ../.github/scripts/check-tree-sitter-upgrade-readiness.py --assert-current | grep cuda
# -> OK   tree-sitter-cuda: installed ABI 14 in range [intentional pin: 0.20.6]
```

### 2. Index a CUDA repository

Run from inside `gitnexus/` (or after `npm link` / global install). The CLI
entry is `dist/cli/index.js` after a build:

```bash
# From a git repo:
node dist/cli/index.js analyze /path/to/gpu-project

# From any folder without a .git directory:
node dist/cli/index.js analyze /path/to/gpu-project --skip-git
```

You should see CUDA files contribute symbols. Quick checks:

```bash
cd /path/to/gpu-project

# CUDA functions/kernels are indexed:
node /path/to/GitNexus/gitnexus/dist/cli/index.js cypher \
  "MATCH (n:Function) RETURN n.name, n.filePath ORDER BY n.name"

# Call edges resolve (kernel launches, device calls, cross-file/-language):
node /path/to/GitNexus/gitnexus/dist/cli/index.js cypher \
  "MATCH (a)-[r]->(b) WHERE r.type='CALLS' RETURN a.name, b.name"
```

(If multiple repos are indexed, add `--repo <name>` to scoped commands.)

### 3. Run the MCP server

GitNexus exposes the same code-intelligence tools over MCP. Point your editor at
this fork's built CLI:

```bash
# stdio MCP server (what editors spawn) — serves all indexed repos:
node /path/to/GitNexus/gitnexus/dist/cli/index.js mcp

# or the HTTP server used by the web UI:
node /path/to/GitNexus/gitnexus/dist/cli/index.js serve   # http://localhost:4747
```

For Cursor / Claude Code / Codex, register the MCP server (one-time):

```bash
node /path/to/GitNexus/gitnexus/dist/cli/index.js setup
```

Or add it manually to your editor's MCP config (Cursor `~/.cursor/mcp.json`,
Claude Code `~/.claude.json`, etc.):

```json
{
  "mcpServers": {
    "gitnexus": {
      "command": "node",
      "args": ["/path/to/GitNexus/gitnexus/dist/cli/index.js", "mcp"]
    }
  }
}
```

Once connected, the standard tools (`query`, `context`, `impact`,
`detect_changes`, …) operate on CUDA symbols exactly as they do for C++.

---

## Implementation notes (for maintainers)

Files changed to add CUDA support:

| Area | File | Change |
|------|------|--------|
| Detection | `gitnexus-shared/src/language-detection.ts` | `.cu`/`.cuh` → `CPlusPlus`; added case‑insensitive `isCudaFilename` (single source of truth) |
| Provider | `gitnexus/src/core/ingestion/languages/c-cpp.ts` | `.cu`/`.cuh` in `cppProvider.extensions` |
| Grammar (loader) | `gitnexus/src/core/tree-sitter/parser-loader.ts` | `cpp:cuda` grammar variant + `fallbackKey` → C++; `resolveLanguageKey` routes `.cu`/`.cuh` (case‑insensitive) |
| Grammar (worker) | `gitnexus/src/core/ingestion/workers/parse-worker.ts` | optional CUDA grammar, CUDA file group split, C++ fallback — the **primary** symbol-extraction path |
| Scope resolution | `gitnexus/src/core/ingestion/languages/cpp/query.ts`, `cpp/captures.ts` | compile/run the C++ scope query against the **same** grammar as the parsed tree (CUDA for `.cu`/`.cuh`); a cross‑grammar query silently matches nothing — this is what enables CALLS edges for CUDA |
| Reachability | `gitnexus/src/core/ingestion/import-resolvers/utils.ts` | `.cu`/`.cuh` recognized as C/C++ include targets |
| Deps | `gitnexus/package.json` | exact pin `tree-sitter-cuda@0.20.6` (optionalDependency) |
| ABI tracking | `.github/scripts/check-tree-sitter-upgrade-readiness.py` | added `tree-sitter-cuda` to the grammar matrix + intentional‑pin rationale |

Tests: `gitnexus/test/unit/parser-loader.test.ts` (grammar load + parse/walk +
routing), `parser-loader-cuda-fallback.test.ts` (missing‑grammar fallback,
subprocess), `parser-loader-abi.test.ts` (ABI smoke), and
`gitnexus/test/integration/cuda-parse.test.ts` (worker **and** sequential symbol
extraction, parity, and the kernel‑launch CALLS edge).

### Key design decision

The critical mechanism: tree‑sitter assigns node‑type IDs **per grammar
instance**, so a query compiled against grammar A run on a tree parsed by
grammar B matches **nothing** (no error). Because CUDA files are parsed with the
CUDA grammar, every place that runs a C++ query against a CUDA tree must use a
CUDA‑compiled query. The fix selects the grammar from the file path (`.cu`/`.cuh`
→ CUDA when installed, else the C++ fallback), kept consistent across the loader,
the worker, and the scope‑resolution path via the shared `isCudaFilename` helper.
