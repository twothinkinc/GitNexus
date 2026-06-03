<!-- version: 2.0.0 -->

# CUDA support (GitNexus fork)

This fork makes GitNexus index **CUDA** (`.cu` / `.cuh`) sources — kernels,
`__device__`/`__host__` functions, and call edges (including `<<<...>>>` kernel
launches and C++↔CUDA calls). Upstream GitNexus skips `.cu`/`.cuh` entirely.

> **Not published to npm.** `npx gitnexus` / `npm i -g gitnexus` are **upstream
> (no CUDA)**. Build and run from this checkout.

## Setup (CLI + MCP)

Requires **Node ≥ 22**.

```bash
git clone https://github.com/twothinkinc/GitNexus.git
cd GitNexus/gitnexus-shared && npm install && npm run build
cd ../gitnexus
export GITNEXUS_SKIP_WEB=1     # skip the browser-UI build; CLI/MCP don't need it
npm install                    # builds dist/cli/index.js

# Put a launcher on your PATH under a distinct name (won't clash with upstream `gitnexus`):
ln -sf "$PWD/dist/cli/index.js" "$(npm config get prefix)/bin/gitnexus-cuda"
gitnexus-cuda --version
```

## Index a repo

```bash
gitnexus-cuda analyze /path/to/gpu-project
```

Quick check (CUDA symbols are in the graph):

```bash
gitnexus-cuda cypher "MATCH (n:Function) WHERE n.filePath ENDS WITH '.cu' OR n.filePath ENDS WITH '.cuh' RETURN n.name, n.filePath"
```

## MCP

Point your editor at the build's **absolute path** (don't use `gitnexus setup`
or `npx` — they resolve to upstream). Cursor — `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "gitnexus": { "command": "node",
  "args": ["/ABS/PATH/TO/GitNexus/gitnexus/dist/cli/index.js", "mcp"] } } }
```

Restart the editor; `query` / `context` / `impact` then work on CUDA symbols.

## Notes

- `npm install` failing on `@rolldown/binding-…` or Vite → you forgot
  `export GITNEXUS_SKIP_WEB=1`. It must be exported (the build runs on
  `npm install` / `npm link`).
- `tree-sitter-cuda` is an optional dep pinned to `0.20.6`; if it can't install,
  `.cu`/`.cuh` still parse via `tree-sitter-cpp` (no `<<<...>>>` support).
- License: upstream is **PolyForm Noncommercial** — clear commercial use /
  redistribution with akonlabs before publishing this fork.
