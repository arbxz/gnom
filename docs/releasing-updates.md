# Releasing updates

gnom ships with the Tauri self-updater: the app asks GitHub whether a newer
release exists, verifies its signature, installs it and restarts. No store, no
account.

## How it's wired

- **Plugins**: `tauri-plugin-updater` + `tauri-plugin-process`, registered
  under `#[cfg(desktop)]` in [`lib.rs`](../src-tauri/src/lib.rs).
- **Client**: [`src/lib/updater.ts`](../src/lib/updater.ts). A quiet check on
  launch (from `App.tsx`) that only speaks up when an update exists, and a
  manual check under **Settings → About** that reports either way.
- **Nothing installs on its own.** Installing restarts the app, and a restart
  mid-delete would abandon the walk, so the install only runs on a click.
- **Config**: [`tauri.conf.json`](../src-tauri/tauri.conf.json) —
  `bundle.createUpdaterArtifacts: true`, `bundle.targets: ["nsis"]`, and
  `plugins.updater` holding the public key and the endpoint.
- **Permissions**: `updater:default`, `process:default` in
  [`capabilities/default.json`](../src-tauri/capabilities/default.json).

Only NSIS is bundled on purpose. With `targets: "all"`, the manifest's default
`windows-x86_64` entry points at the MSI while most people install the
`setup.exe`, so an update would install a second copy of the app a different
way.

## The signing key

| Item | Value |
| --- | --- |
| Private key | `%USERPROFILE%\.tauri\gnom.key` ← **secret, back it up** |
| Public key | `%USERPROFILE%\.tauri\gnom.key.pub` (committed in `tauri.conf.json`) |
| Password | *(empty)* |

> **If you lose the private key, no installed copy will ever accept another
> update.** Each install trusts only this key; a new one means everybody has to
> download a fresh installer by hand.

Back it up now if you haven't: copy the file's contents into a password
manager. Copy it to the clipboard without it appearing on screen with

```powershell
Get-Content "$env:USERPROFILE\.tauri\gnom.key" -Raw | Set-Clipboard
```

Regenerating (only when starting over — this strands every existing install):

```powershell
pnpm tauri signer generate --ci -p "" -w "$env:USERPROFILE\.tauri\gnom.key" -f
```

## One-time GitHub setup

1. The repo must be **public**, or the updater cannot download release assets
   without a token.
2. Add the private key as the repo secret **`TAURI_SIGNING_PRIVATE_KEY`**
   (Settings → Secrets and variables → Actions). Paste the file's contents, not
   its path. No password secret is needed.

## Cutting a release

1. **Bump the version in all three files, which must agree:**
   `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
   If they disagree, installed copies may never see the release.
2. Commit, then tag and push the tag — the tag is what triggers
   [`release.yml`](../.github/workflows/release.yml):

   ```powershell
   git commit -am "release: v0.2.0"
   git tag v0.2.0
   git push origin master --tags
   ```

3. Watch the run under **Actions**. It takes roughly 5–10 minutes, most of it
   compiling Rust. It publishes the installer, its `.sig`, and `latest.json`.

## Verifying a release (don't skip this)

The release page looking right does not prove the updater works. Check the
endpoint the app actually calls:

```bash
curl -sL https://github.com/arbxz/gnom/releases/latest/download/latest.json
```

Confirm `version` matches the tag, that `platforms` has `windows-x86_64`, and
that its `url` is the `setup.exe`. Then do the real test once: install the
release, publish the next one, and confirm an installed copy offers it.

## Building locally

`createUpdaterArtifacts` makes `pnpm tauri build` require the signing key:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\gnom.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
pnpm tauri build
```

For a quick local build that isn't going to be released, skip signing:

```bash
pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'
```
