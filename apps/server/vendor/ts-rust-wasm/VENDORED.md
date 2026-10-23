# Vendored: ts-rust wasm host + module

Contents of this directory:

- `core.js`, `core.d.ts` — the runtime-independent WASI host of the ts-rust
  npm package `ts-rust-wasm` (`npm/wasm/` upstream): a WASI preview1 shim,
  the host file-system bridge (`memoryFileSystem`), and the `runTsc` /
  `runTscAsync` entry points.
- `ts_rust.wasm` — the ts-rust TypeScript compiler (a Rust port of
  typescript-go) compiled for `wasm32-wasip1`. ~6.2 MB, built without
  wasm-opt so a regen needs only `cargo` + the Rust target.
- `package.json` — ours, not upstream's: just `type: module` so
  `createRequire` loads `core.js` through Node's `require(esm)` path.
- `LICENSE`, `NOTICE.md`, `TypeScript-LICENSE.txt`, `TypeScript-NOTICE.txt` —
  upstream attribution. ts-rust is `MIT AND Apache-2.0`; the wasm module
  embeds a port of the TypeScript compiler (Apache-2.0).

## Provenance

- Upstream: <https://github.com/pingdotgg/ts-rust>, `npm/wasm/` directory.
- Pinned commit: `780dc512d64f40afebffa6a7028207649fb7ed1c` (main,
  2026-10-14).
- Self-built: `ts-rust-wasm` is not published to npm, so the module was
  compiled from source. Nothing in this directory was hand-edited; `core.js`
  and `core.d.ts` are byte-identical to upstream, `ts_rust.wasm` is the
  build output.

## Regenerating

Run `scripts/build-ts-rust-wasm.sh` from the repo root. It clones the
pinned upstream commit into a temp dir, adds the `wasm32-wasip1` Rust
target, and runs `WASM_OPT=none scripts/wasm/build.sh` with the output
pointed at this directory. `core.js`/`core.d.ts` are only refreshed when
the upstream pin changes — copy them from the same commit when bumping it.

## Consumer

`apps/server/src/watch/WidgetTranspileService.ts` loads this directory at
runtime: it resolves `vendor/ts-rust-wasm/` relative to the service's own
module URL, `require()`s `core.js`, compiles `ts_rust.wasm` once, and runs
`tsc -p` per widget publish against an in-memory file system. When the
files are absent (a Node SEA binary cannot read file assets), the service
falls back to the `tsc-rs` native-binary API.
