import type {
  CleanOutcome,
  CleanProgress,
  DepReport,
  DockerActionKind,
  DockerReport,
  ScanOptions,
  ScanProgress,
  ScanResult,
} from "./types";

/** True inside the Tauri shell; false in a plain browser, where demo data stands in. */
export const isNative = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/** What this system calls the place deleted files go. */
export const trashName = isMac ? "Trash" : "Recycle Bin";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

async function listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => cb(e.payload));
}

const mock = () => import("./mock");
const DEMO_SCAN_KEY = "gnom.demo.lastScan";

export const api = {
  async defaultRoots(): Promise<string[]> {
    return isNative ? invoke("default_roots") : ["C:\\Users\\dev"];
  },

  /** The previous session's results, or null on first run. Demo mode keeps them in localStorage. */
  async lastScan(): Promise<ScanResult | null> {
    if (isNative) return invoke<ScanResult | null>("load_last_scan");
    try {
      const raw = localStorage.getItem(DEMO_SCAN_KEY);
      return raw ? (JSON.parse(raw) as ScanResult) : null;
    } catch {
      return null;
    }
  },

  async saveScan(result: ScanResult): Promise<void> {
    if (isNative) return invoke("save_scan", { result });
    try {
      localStorage.setItem(DEMO_SCAN_KEY, JSON.stringify(result));
    } catch {
      /* storage full or blocked: the demo just forgets */
    }
  },

  async scan(opts: ScanOptions, onProgress: (p: ScanProgress) => void): Promise<ScanResult> {
    if (!isNative) {
      const r = await (await mock()).mockScan(onProgress);
      await api.saveScan(r);
      return r;
    }
    const unlisten = await listen<ScanProgress>("scan-progress", onProgress);
    try {
      return await invoke<ScanResult>("start_scan", { opts });
    } finally {
      unlisten();
    }
  },

  async cancelScan(): Promise<void> {
    if (isNative) await invoke("cancel_scan");
    else (await mock()).cancelMock();
  },

  async clean(items: { path: string; size: number }[], toTrash: boolean, onProgress: (p: CleanProgress) => void): Promise<CleanOutcome[]> {
    if (!isNative) return (await mock()).mockClean(items, onProgress);
    const unlisten = await listen<CleanProgress>("clean-progress", onProgress);
    try {
      return await invoke<CleanOutcome[]>("clean_paths", { items, toTrash });
    } finally {
      unlisten();
    }
  },

  async runCacheCommand(id: string): Promise<string> {
    if (!isNative) return `(demo) ran clean command for ${id}`;
    return invoke("run_cache_command", { id });
  },

  async docker(): Promise<DockerReport> {
    return isNative ? invoke("docker_report") : (await mock()).mockDocker();
  },

  async dockerAction(kind: DockerActionKind, ids: string[] = []): Promise<string> {
    if (!isNative) return "(demo) done";
    return invoke("docker_action", { args: { kind, ids } });
  },

  async checkDeps(project: string): Promise<DepReport> {
    return isNative ? invoke("check_deps", { project }) : (await mock()).mockDeps();
  },

  async reveal(path: string): Promise<void> {
    if (isNative) await invoke("reveal", { path });
  },

  async window(action: "minimize" | "toggleMaximize" | "close" | "startDragging"): Promise<void> {
    if (!isNative) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow()[action]();
  },
};
