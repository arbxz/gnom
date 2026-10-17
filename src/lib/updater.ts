import { isNative } from "./api";

// Self-updater. gnom checks quietly on launch and says nothing unless there is
// something to install; Settings has a manual check that reports either way.
//
// Updates are signed with the key in tauri.conf.json's `plugins.updater.pubkey`
// and verified before anything is written, so a tampered or wrong-key build is
// refused. See docs/releasing-updates.md.

export interface ToastLike {
  (t: {
    kind: "ok" | "error" | "info";
    title: string;
    body?: string;
    action?: { label: string; run: () => void };
  }): void;
}

/** Version of the running app, or null in a plain browser. */
export async function appVersion(): Promise<string | null> {
  if (!isNative) return null;
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

/**
 * Look for a newer release.
 *
 * `silent` is the launch check: it stays quiet when up to date and when the
 * check fails, because neither is worth interrupting someone who opened the
 * app to clear disk space. The manual check reports every outcome.
 */
export async function checkForUpdates(opts: {
  silent: boolean;
  toast: ToastLike;
}): Promise<void> {
  const { silent, toast } = opts;
  if (!isNative) {
    if (!silent) toast({ kind: "info", title: "Updates only work in the installed app" });
    return;
  }

  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();

    if (!update) {
      if (!silent) toast({ kind: "ok", title: "gnom is up to date" });
      return;
    }

    toast({
      kind: "info",
      title: `Version ${update.version} is available`,
      body: "Downloads in the background, then restarts gnom.",
      action: {
        label: "Install",
        run: () => {
          void install(update, toast);
        },
      },
    });
  } catch (e) {
    // Offline, GitHub down, or a malformed manifest all land here.
    if (!silent) {
      toast({ kind: "error", title: "Couldn't check for updates", body: String(e) });
    }
  }
}

type Update = Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater").check>>;

async function install(update: NonNullable<Update>, toast: ToastLike): Promise<void> {
  try {
    toast({ kind: "info", title: `Downloading ${update.version}…` });
    // A delete may be running: finishing the download is fine, but the restart
    // below would kill it, so downloadAndInstall is only started from an
    // explicit click, never automatically.
    await update.downloadAndInstall();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    toast({ kind: "error", title: "Update failed", body: String(e) });
  }
}
