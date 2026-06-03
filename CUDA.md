<!-- version: 1.1.0 -->
<!-- Last updated: 2026-06-02 -->
<!-- 1.1.0: OS-agnostic install (no Homebrew); conflict-proof MCP via absolute
     path; distinct gitnexus-cuda launcher; warn that npx/setup resolve upstream. -->

# CUDA (`.cu` / `.cuh`) support — custom fork

This fork extends GitNexus to fully index **CUDA C++** sources. Before this
change, `.cu` and `.cuh` files were classified as unsupported and ingested as
empty `File` nodes (zero symbols), which blinded code intelligence for GPU
projects whose kernel/device logic lives in `.cu`/`.cuh`.

## Quick start (developers)

> **Read this first — the fork is NOT on npm.** `npx gitnexus` and
> `npm install -g gitnexus` always fetch the **upstream** package, which has **no
> CUDA support**. CUDA only works when you run *this checkout's build*. So we
> point the editor's MCP at the build's **absolute path**, and (optionally) add a
> **distinctly-named** CLI launcher — neither conflicts with any existing
> `gitnexus` you may have installed. This also works in containers/devpods.

```bash
# 1. Node >= 22 is REQUIRED (Node 20 fails the build). Use whatever your
#    environment provides — devcontainer base image, nvm, fnm, volta, asdf,
#    distro package, etc. Just confirm the version:
node -v        # must be >= 22

# 2. Clone the fork and build the CLI (the browser UI is skipped — not needed).
git clone https://github.com/twothinkinc/GitNexus.git
cd GitNexus
cd gitnexus-shared && npm install && npm run build && cd ../gitnexus
export GITNEXUS_SKIP_WEB=1     # keep set for the session; `npm install` runs the build via `prepare`
npm install                    # produces ./dist/cli/index.js

# 3. (optional) Add a CLI launcher on your PATH under a DISTINCT name so it can
#    never clash with an upstream `gitnexus`. Uses npm's own global bin dir,
#    which is portable across nvm / devcontainers / system Node:
GNX_BIN="$(npm config get prefix)/bin"
ln -sf "$PWD/dist/cli/index.js" "$GNX_BIN/gitnexus-cuda"   # dir must be on $PATH
gitnexus-cuda --version        # -> 1.6.5   (see note below about telling fork from upstream)

# 4. Index a repo — CUDA .cu/.cuh fully supported
gitnexus-cuda analyze /path/to/gpu-project
#   (no launcher? use the absolute path: node "$PWD/dist/cli/index.js" analyze <path>)
```

> If `$(npm config get prefix)/bin` isn't writable or on your `$PATH`, use any dir
> that is — e.g. `~/.local/bin` or `/usr/local/bin`. The built `dist/cli/index.js`
> has a `#!/usr/bin/env node` shebang and is executable, so a plain symlink works.

### Wire up MCP (conflict-proof)

Point your editor at the **absolute path** of this build — do **not** use `npx`,
`gitnexus setup`, or a bare `gitnexus` (any of which may resolve to the upstream
package without CUDA). The MCP server *name* stays `gitnexus` so editor skills
and tools work unchanged.

**Cursor** — `~/.cursor/mcp.json` (global) or project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "gitnexus": {
      "command": "node",
      "args": ["/ABS/PATH/TO/GitNexus/gitnexus/dist/cli/index.js", "mcp"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add gitnexus -- node /ABS/PATH/TO/GitNexus/gitnexus/dist/cli/index.js mcp
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.gitnexus]
command = "node"
args = ["/ABS/PATH/TO/GitNexus/gitnexus/dist/cli/index.js", "mcp"]
```

Restart the editor. One MCP server serves **all** repos you've indexed — index
more anytime and they appear automatically; re-run `analyze` to refresh a stale
index.

### Avoiding conflicts with an existing `gitnexus`

- **Following the steps above = no conflict.** MCP uses the fork's absolute path;
  the CLI uses the distinct name `gitnexus-cuda`. Any existing `npx gitnexus` /
  `npm i -g gitnexus` keeps working for non-CUDA repos, untouched.
- **Prefer the fork to *be* your `gitnexus`?** Remove the global and link the fork:
  ```bash
  npm rm -g gitnexus                     # drop the upstream global (npx still pulls upstream)
  cd /ABS/PATH/TO/GitNexus/gitnexus
  GITNEXUS_SKIP_WEB=1 npm link           # `gitnexus` now = this fork
  ```
  After this, `gitnexus setup` is safe to use (it resolves `which gitnexus` → the
  fork). Note `npx gitnexus@…` will *still* fetch upstream — always use the
  linked binary or the absolute path for CUDA work.
- **Which one am I running?** `--version` is `1.6.5` for both fork and upstream, so
  it can't tell them apart. Verify with the resolved path
  (`readlink -f "$(command -v gitnexus)"`) or by indexing a `.cu` file and
  checking for symbols (see [Verify](#verify-cuda-is-indexed)).

> **`npm install` errors with `@rolldown/binding-…` or a Vite message?** You
> didn't `export GITNEXUS_SKIP_WEB=1` — that's the browser UI (`gitnexus-web`),
> which the CLI/MCP doesn't use. Set the flag and re-run. (It must be exported
> because `npm install` / `npm link` / `npm ci` all run the build via `prepare`.)

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

# Install + build the CLI (pulls tree-sitter-cuda@0.20.6, prebuilt).
npm install                    # produces ./dist/cli/index.js

# Add a CLI launcher under a DISTINCT name so it can't clash with an upstream
# `gitnexus` (see "Avoiding conflicts" above). Or skip this and call
# dist/cli/index.js by absolute path everywhere.
ln -sf "$PWD/dist/cli/index.js" "$(npm config get prefix)/bin/gitnexus-cuda"
gitnexus-cuda --version
```

> Why `export GITNEXUS_SKIP_WEB=1`? `npm install` / `npm link` / `npm ci` all
> re-run `prepare` → the build, which fails on the web-UI build without the flag.
> If you forgot to export it, prefix the command (`GITNEXUS_SKIP_WEB=1 npm install`).
>
> Prefer `gitnexus` to be the fork instead of a distinct name? `npm rm -g gitnexus`
> then `GITNEXUS_SKIP_WEB=1 npm link` (see "Avoiding conflicts").
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

Use the launcher (`gitnexus-cuda`) or the absolute path to `dist/cli/index.js`:

```bash
# From a git repo:
gitnexus-cuda analyze /path/to/gpu-project

# From any folder without a .git directory:
gitnexus-cuda analyze /path/to/gpu-project --skip-git
```

### Verify CUDA is indexed

```bash
# CUDA functions/kernels are indexed (kernels, __device__/__host__ functions):
gitnexus-cuda cypher --repo <name> \
  "MATCH (n:Function) WHERE n.filePath ENDS WITH '.cu' OR n.filePath ENDS WITH '.cuh' \
   RETURN n.name, n.filePath ORDER BY n.name"

# Call edges resolve (kernel launches, device calls, cross-file / cross-language):
gitnexus-cuda cypher --repo <name> \
  "MATCH (a)-[r]->(b) WHERE r.type='CALLS' RETURN a.name, b.name"
```

`--repo <name>` is required only when more than one repo is indexed
(`gitnexus-cuda list` shows the names). A repo whose `.cu`/`.cuh` files live under
indexer-excluded paths (e.g. `test/fixtures/`) won't show them — that's the
exclusion, not a CUDA issue; point `analyze` at real source dirs.

### 3. Run the MCP server

Configure your editor's MCP **by absolute path** (see the conflict-proof config
in [Wire up MCP](#wire-up-mcp-conflict-proof) above for Cursor / Claude Code /
Codex). In short:

```json
{ "mcpServers": { "gitnexus": { "command": "node",
  "args": ["/ABS/PATH/TO/GitNexus/gitnexus/dist/cli/index.js", "mcp"] } } }
```

> **Do not** use `gitnexus setup` or `npx gitnexus` for the fork unless you've
> made the fork your global `gitnexus` (the "remove and link" path in
> [Avoiding conflicts](#avoiding-conflicts-with-an-existing-gitnexus)). `setup`
> writes the MCP entry from `which gitnexus` and otherwise falls back to
> `npx gitnexus@<ver>` — both of which resolve to the **upstream** package
> (no CUDA). The absolute-path config above always uses this build.

To run the server directly (debugging) or the HTTP backend:

```bash
node /ABS/PATH/TO/GitNexus/gitnexus/dist/cli/index.js mcp      # stdio MCP (what editors spawn)
node /ABS/PATH/TO/GitNexus/gitnexus/dist/cli/index.js serve    # HTTP API on http://localhost:4747
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
