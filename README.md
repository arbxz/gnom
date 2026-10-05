# gnom

A small desktop app that finds the disk space your dev work left behind and clears it safely.

- **Project junk**: `node_modules`, Rust and Tauri `target/`, `.next`, `dist`, `.turbo`, `__pycache__`, Python venvs, `.gradle`, .NET `bin/obj`, Flutter `.dart_tool`, CMake builds, and more. Each item is tied to its project and flagged **stale** when the project hasn't been touched for N days.
- **Package caches**: pnpm store, npm, Yarn, Bun, Cargo registry, pip/uv, Gradle, Maven, NuGet, Go, Playwright, Cypress, and more. Where a tool has an official clean command (`pnpm store prune`, `npm cache clean --force`, …), gnom can run it for you.
- **Docker**: unused or dangling images, stopped containers, volumes and build cache, plus the WSL `.vhdx` files that never shrink by themselves.
- **Heavy files** inside projects: recordings, dumps, model weights, archives, debug symbols.
- **Unused npm deps**: a quick check for packages in `package.json` that nothing imports.
- **Disk map**: a zoomable treemap of everything scanned, with the dev junk in colour.

Deletion only accepts paths reported by the last scan. You can delete permanently (fast) or move items to the Recycle Bin.

## Develop

```bash
pnpm install
pnpm tauri dev
```

`pnpm dev` runs the UI alone in a browser on demo data.

Run the scanner against a real folder without the UI:

```bash
cd src-tauri && GNOM_ROOT=C:\code cargo test --lib real_scan -- --ignored --nocapture
```

## Build

```bash
pnpm tauri build
```

Stack: Tauri 2 (Rust + rayon walker), React 19, d3-hierarchy, lucide icons.
