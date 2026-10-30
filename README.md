# gnom

A small Windows app that finds the disk space your dev work left behind and clears it safely.

Tauri `target/` folders that quietly grow to 10–20 GB, `node_modules` in projects you haven't opened in a year, package caches, Docker images nothing uses: gnom finds them, shows how big they are and how stale, and deletes the ones you pick.

## Install

1. Download `gnom_<version>_x64-setup.exe` from the [latest release](https://github.com/arbxz/gnom/releases/latest).
2. Run it. It installs for your user only, so no admin prompt.
3. The installer isn't code-signed yet, so Windows SmartScreen may say *"Windows protected your PC"*. Choose **More info → Run anyway**.

gnom updates itself: it checks for a new release on launch and offers to install it. Updates are signed, and gnom refuses any update not signed with its own key. You can also check from **Settings**.

To uninstall, use **Windows Settings → Apps → gnom**.

## What it finds

- **Project junk**: `node_modules`, Rust and Tauri `target/`, `.next`, `dist`, `.turbo`, `__pycache__`, Python venvs, `.gradle`, .NET `bin/obj`, Flutter `.dart_tool`, CMake builds, and more. Each item is tied to its project and flagged **stale** when the project hasn't been touched for a set number of days.
- **Package caches**: pnpm store, npm, Yarn, Bun, Cargo registry, pip/uv, Gradle, Maven, NuGet, Go, Playwright, Cypress, and more. Where a tool has an official clean command (`pnpm store prune`, `npm cache clean --force`, …), gnom can run it for you.
- **Containers** (Docker Desktop, OrbStack, Rancher Desktop or Podman): unused or dangling images, stopped containers, unused volumes and build cache, plus the WSL `.vhdx` files that never shrink by themselves. Containers and volumes are removed only one by one, as you pick them.
- **Heavy files** inside projects: recordings, dumps, model weights, archives, debug symbols.
- **Unused npm deps**: a quick check for packages in `package.json` that nothing imports.
- **Disk map**: a zoomable map of everything scanned, with the dev junk in colour.

## Deleting safely

- gnom only deletes paths its last scan reported; anything else is refused.
- You choose between deleting permanently (fast) and moving to the Recycle Bin (slow for huge folders, and the space comes back only when you empty the bin).
- Dependencies and builds come back with the restore command shown next to them (`pnpm install`, `cargo build`, …). Heavy files don't, so gnom never bulk-selects them.
- Links and junctions (pnpm's `node_modules` is full of them) are removed without touching what they point to.
- Some places are never deleted from disk:
  - container engines and their data: Docker Desktop, OrbStack, Rancher Desktop, Podman, minikube, Lima;
  - every WSL distro folder and any `.vhd`/`.vhdx` disk;
  - virtual machines: Hyper-V, VirtualBox, VMware;
  - installed programs, under Program Files and `%LOCALAPPDATA%\Programs`.
- Folders inside AppData and ProgramData belong to installed apps, so gnom reports no junk there. Package caches are the exception: they are found by their known locations.
- Container changes go through the engine's own CLI, and you confirm each one first. The engine itself refuses to remove anything still in use.
- If a delete fails, files probably changed since the scan: rescan and try again.

## Your data and the network

- **Everything stays on your machine.** No accounts, no telemetry, no analytics.
- **What gnom stores:** your settings, and the results of your last scan in `%APPDATA%\com.arbxz.gnom\last-scan.json`, so it reopens on them. The results include folder paths and sizes from your disk. Uninstalling removes the app, not this file; delete the folder if you want it gone.
- **What gnom sends:** one request on launch to `github.com/arbxz/gnom` to see whether a newer version exists. No information about you or your files is sent.
- **Commands it runs:** the `docker` CLI to list images and containers, and a cache's own clean command when you press **Run**. Those tools may use the network themselves (for example `npm`).

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

Build an installer with `pnpm tauri build`. Releases are built, signed and published by CI when a version tag is pushed; see [docs/releasing-updates.md](docs/releasing-updates.md).

Stack: Tauri 2 (Rust + rayon walker), React 19, d3-hierarchy, lucide icons.

## Licence

Copyright © 2026 arbxz. All rights reserved. The source is published for transparency; it is not licensed for reuse or redistribution. See [LICENSE](LICENSE).
