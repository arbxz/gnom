import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./lib/api";
import { ago, bytes, daysSince } from "./lib/format";
import { useSettings, type Settings } from "./lib/settings";
import type { CleanProgress, DockerReport, Finding, ScanProgress, ScanResult, TreeNode } from "./lib/types";

export type View = "overview" | "projects" | "caches" | "docker" | "large" | "map" | "settings";

export interface Toast {
  id: number;
  kind: "ok" | "error" | "info";
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
}

interface Store {
  settings: Settings;
  updateSettings: (p: Partial<Settings>) => void;
  view: View;
  setView: (v: View) => void;
  result: ScanResult | null;
  /** True until the previous session's results have been looked up. */
  restoring: boolean;
  scanning: boolean;
  progress: ScanProgress | null;
  startScan: () => void;
  cancelScan: () => void;
  selected: Set<string>;
  toggle: (path: string) => void;
  setMany: (paths: string[], on: boolean) => void;
  clearSelection: () => void;
  selectedFindings: Finding[];
  confirmOpen: boolean;
  setConfirmOpen: (v: boolean) => void;
  cleaning: boolean;
  cleanProgress: CleanProgress | null;
  cleanSelected: () => Promise<void>;
  isStale: (lastActive: number | null) => boolean;
  docker: DockerReport | null;
  dockerLoading: boolean;
  loadDocker: () => void;
  toasts: Toast[];
  toast: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside provider");
  return s;
}

const norm = (p: string) => p.toLowerCase();
const sum = (items: { size: number }[]) => items.reduce((a, b) => a + b.size, 0);

/** Removes deleted paths from the size tree and shrinks every ancestor accordingly. */
function pruneTree(nodes: TreeNode[], removed: Map<string, number>): TreeNode[] {
  return nodes
    .filter((n) => !removed.has(norm(n.path)))
    .map((n) => {
      const prefix = norm(n.path).replace(/[\\/]$/, "");
      let gone = 0;
      for (const [p, size] of removed) if (p.startsWith(prefix + "\\") || p.startsWith(prefix + "/")) gone += size;
      if (!gone) return n;
      return { ...n, size: Math.max(0, n.size - gone), children: pruneTree(n.children, removed) };
    });
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [settings, updateSettings] = useSettings();
  const [view, setView] = useState<View>("overview");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanProgress, setCleanProgress] = useState<CleanProgress | null>(null);
  const [docker, setDocker] = useState<DockerReport | null>(null);
  const [dockerLoading, setDockerLoading] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = ++toastId.current;
      setToasts((all) => [...all.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.action ? 20000 : t.kind === "error" ? 9000 : 5000);
    },
    [dismiss],
  );

  useEffect(() => {
    if (settings.roots.length === 0) api.defaultRoots().then((roots) => updateSettings({ roots }));
    api
      .lastScan()
      .then((r) => r && setResult(r))
      .catch(() => {
        /* unreadable cache: start empty, the next scan rewrites it */
      })
      .finally(() => setRestoring(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDocker = useCallback(() => {
    setDockerLoading(true);
    api
      .docker()
      .then(setDocker)
      .catch((e) => toast({ kind: "error", title: "Docker check failed", body: String(e) }))
      .finally(() => setDockerLoading(false));
  }, [toast]);

  const startScan = useCallback(() => {
    if (scanning || settings.roots.length === 0) return;
    setScanning(true);
    setProgress(null);
    setSelected(new Set());
    loadDocker();
    api
      .scan({ roots: settings.roots, exclude: settings.exclude, largeFileMb: settings.largeFileMb }, setProgress)
      .then((r) => {
        setResult(r);
        if (r.cancelled) toast({ kind: "info", title: "Scan stopped", body: "Showing what was found so far." });
      })
      .catch((e) => toast({ kind: "error", title: "Scan failed", body: String(e) }))
      .finally(() => setScanning(false));
  }, [scanning, settings.roots, settings.exclude, settings.largeFileMb, loadDocker, toast]);

  const findingByPath = useMemo(() => new Map(result?.findings.map((f) => [f.path, f]) ?? []), [result]);
  const selectedFindings = useMemo(
    () => [...selected].map((p) => findingByPath.get(p)).filter((f): f is Finding => !!f),
    [selected, findingByPath],
  );

  const toggle = useCallback((path: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (!n.delete(path)) n.add(path);
      return n;
    });
  }, []);
  const setMany = useCallback((paths: string[], on: boolean) => {
    setSelected((s) => {
      const n = new Set(s);
      for (const p of paths) on ? n.add(p) : n.delete(p);
      return n;
    });
  }, []);

  const cleanSelected = useCallback(async () => {
    const items = selectedFindings;
    if (!items.length) return;
    setCleaning(true);
    setCleanProgress({ freed: 0, total: sum(items), index: 0, count: items.length, current: items[0].path });
    try {
      const outcomes = await api.clean(
        items.map((f) => ({ path: f.path, size: f.size })),
        settings.toTrash,
        setCleanProgress,
      );
      const ok = new Set(outcomes.filter((o) => o.ok).map((o) => o.path));
      const failed = outcomes.filter((o) => !o.ok);
      const freed = items.filter((f) => ok.has(f.path)).reduce((a, f) => a + f.size, 0);
      const removed = new Map(items.filter((f) => ok.has(f.path)).map((f) => [norm(f.path), f.size]));
      if (result && ok.size) {
        const byProject = new Map<string, number>();
        for (const f of items) if (ok.has(f.path) && f.project) byProject.set(f.project, (byProject.get(f.project) ?? 0) + f.size);
        const next: ScanResult = {
          ...result,
          findings: result.findings.filter((f) => !ok.has(f.path)),
          projects: result.projects.map((p) => (byProject.has(p.path) ? { ...p, size: p.size - byProject.get(p.path)! } : p)),
          tree: pruneTree(result.tree, removed),
        };
        setResult(next);
        // Keep the saved copy in step, so cleaned items don't reappear next launch.
        api.saveScan(next).catch(() => {});
      }
      setSelected((s) => new Set([...s].filter((p) => !ok.has(p))));
      if (ok.size)
        toast({
          kind: "ok",
          title: `Freed ${bytes(freed)}`,
          body: `${ok.size} item${ok.size > 1 ? "s" : ""} ${settings.toTrash ? "moved to the Recycle Bin" : "deleted"}.`,
        });
      if (failed.length)
        toast({
          kind: "error",
          title: `${failed.length} item${failed.length > 1 ? "s" : ""} could not be removed`,
          body: `${failed[0].error ?? "Unknown error"}. Files may have changed since the scan from ${ago(result?.finishedAt)}. Re-run the scan to refresh the list before trying again.`,
          action: { label: "Rescan now", run: startScan },
        });
      setConfirmOpen(false);
    } catch (e) {
      toast({ kind: "error", title: "Clean failed", body: String(e) });
    } finally {
      setCleaning(false);
      setCleanProgress(null);
    }
  }, [selectedFindings, settings.toTrash, toast, result, startScan]);

  const isStale = useCallback((t: number | null) => daysSince(t) > settings.staleDays, [settings.staleDays]);

  const value: Store = {
    settings,
    updateSettings,
    view,
    setView,
    result,
    restoring,
    scanning,
    progress,
    startScan,
    cancelScan: () => void api.cancelScan(),
    selected,
    toggle,
    setMany,
    clearSelection: () => setSelected(new Set()),
    selectedFindings,
    confirmOpen,
    setConfirmOpen,
    cleaning,
    cleanProgress,
    cleanSelected,
    isStale,
    docker,
    dockerLoading,
    loadDocker,
    toasts,
    toast,
    dismiss,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
