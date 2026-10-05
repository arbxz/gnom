import {
  AlertTriangle,
  CheckCircle2,
  Container,
  Copy,
  Database,
  FileWarning,
  FolderGit2,
  Info,
  LayoutDashboard,
  LayoutGrid,
  Minus,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import type { CleanProgress } from "../lib/types";
import { api, isNative } from "../lib/api";
import { bytes, count } from "../lib/format";
import { CATEGORIES, CATEGORY } from "../lib/meta";
import { useStore, type View } from "../state";
import { AppIcon, Logo, sum } from "./ui";

export function TitleBar() {
  const { scanning, startScan, result } = useStore();
  return (
    <div className="titlebar glass">
      <div className="brand" data-tauri-drag-region>
        <Logo />
        gnom
      </div>
      {!isNative && <span className="chip accent">Demo data</span>}
      <div className="drag" data-tauri-drag-region onMouseDown={(e) => e.detail === 2 && api.window("toggleMaximize")} />
      {result && (
        <button className="btn sm tinted" onClick={startScan} disabled={scanning}>
          <RefreshCw size={14} className={scanning ? "spin" : ""} /> {scanning ? "Scanning…" : "Rescan"}
        </button>
      )}
      {isNative && (
        <div className="winctl">
          <button aria-label="Minimize" onClick={() => api.window("minimize")}>
            <Minus size={16} />
          </button>
          <button aria-label="Maximize" onClick={() => api.window("toggleMaximize")}>
            <Square size={12} />
          </button>
          <button className="close" aria-label="Close" onClick={() => api.window("close")}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

const NAV: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "projects", label: "Projects", icon: FolderGit2 },
  { id: "caches", label: "Package caches", icon: Database },
  { id: "docker", label: "Docker", icon: Container },
  { id: "large", label: "Heavy files", icon: FileWarning },
  { id: "map", label: "Disk map", icon: LayoutGrid },
];

export function Sidebar() {
  const { view, setView, result, docker } = useStore();
  const f = result?.findings ?? [];
  const meta: Partial<Record<View, string>> = result
    ? {
        overview: bytes(sum(f)),
        projects: String(result.projects.length),
        caches: bytes(sum(f.filter((x) => x.category === "global"))),
        large: String(f.filter((x) => x.category === "large").length),
        docker: docker?.running ? bytes(docker.df.reduce((a, r) => a + r.reclaimable, 0)) : undefined,
      }
    : {};
  return (
    <nav className="sidebar glass" aria-label="Sections">
      <h6>Library</h6>
      {NAV.map((n) => (
        <button key={n.id} className="nav-item" aria-current={view === n.id ? "page" : undefined} onClick={() => setView(n.id)}>
          <AppIcon icon={n.icon} />
          <span className="label">{n.label}</span>
          {meta[n.id] && <span className="meta num">{meta[n.id]}</span>}
        </button>
      ))}
      <div className="spacer" />
      {result && (
        <div className="disk-meter">
          <div className="secondary" style={{ marginBottom: 6 }}>
            Scanned <b className="num">{bytes(result.bytes)}</b> in {count(result.files)} files
          </div>
          <div className="bar">
            {CATEGORIES.map((c) => {
              const s = sum(f.filter((x) => x.category === c));
              return s ? <span key={c} style={{ width: `${(s / result.bytes) * 100}%`, background: CATEGORY[c].color }} /> : null;
            })}
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            {((sum(f) / Math.max(1, result.bytes)) * 100).toFixed(0)}% is dev junk
          </div>
        </div>
      )}
      <button className="nav-item" aria-current={view === "settings" ? "page" : undefined} onClick={() => setView("settings")}>
        <AppIcon icon={SettingsIcon} />
        <span className="label">Settings</span>
      </button>
    </nav>
  );
}

export function Welcome() {
  const { settings, updateSettings, startScan, scanning, progress, cancelScan } = useStore();
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim().replace(/^"|"$/g, "");
    if (v && !settings.roots.includes(v)) updateSettings({ roots: [...settings.roots, v] });
    setDraft("");
  };
  if (scanning) {
    return (
      <div className="welcome">
        <div className="welcome-card glass" aria-live="polite">
          <div className="ring" aria-hidden="true" />
          <h1>Sweeping…</h1>
          <p className="phase">{progress?.phase || "Starting"}</p>
          <div className="progress-stats">
            <div>
              <b>{count(progress?.files ?? 0)}</b>
              <span>files</span>
            </div>
            <div>
              <b>{bytes(progress?.bytes ?? 0)}</b>
              <span>measured</span>
            </div>
            <div>
              <b>{progress?.found ?? 0}</b>
              <span>things found</span>
            </div>
          </div>
          <div className="current-path" title={progress?.current}>
            {progress?.current || " "}
          </div>
          <button className="btn" onClick={cancelScan}>
            Stop
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="welcome">
      <div className="welcome-card glass">
        <Logo size={64} />
        <h1>Find the gigabytes your builds left behind</h1>
        <p>
          gnom looks for <b>node_modules</b>, Rust &amp; Tauri <b>target</b> folders, stale build output, package caches, heavy files and Docker leftovers — then lets you clear them safely.
        </p>
        <div className="roots" aria-label="Folders to scan">
          {settings.roots.map((r) => (
            <span key={r} className="root-chip">
              {r}
              <button aria-label={`Remove ${r}`} onClick={() => updateSettings({ roots: settings.roots.filter((x) => x !== r) })}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
        <form
          style={{ display: "flex", gap: 8, marginBottom: 18 }}
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input className="field mono" style={{ flex: 1 }} placeholder="Add another folder, e.g. D:\dev" aria-label="Folder to add" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button className="btn" type="submit" disabled={!draft.trim()}>
            <Plus size={15} /> Add
          </button>
        </form>
        <button className="btn primary lg" onClick={startScan} disabled={settings.roots.length === 0}>
          Scan {settings.roots.length > 1 ? `${settings.roots.length} folders` : "now"}
        </button>
        <div className="finds">
          {CATEGORIES.map((c) => (
            <span key={c} className="chip">
              <span className="dot" style={{ background: CATEGORY[c].color, width: 8, height: 8 }} /> {CATEGORY[c].label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Tray() {
  const { selectedFindings, clearSelection, setConfirmOpen } = useStore();
  if (!selectedFindings.length) return null;
  return (
    <div className="tray glass" role="region" aria-label="Selection">
      <span>
        <span className="total">{bytes(sum(selectedFindings))}</span> <span className="secondary">· {selectedFindings.length} selected</span>
      </span>
      <button className="btn sm" onClick={clearSelection}>
        Clear
      </button>
      <button className="btn sm danger" onClick={() => setConfirmOpen(true)}>
        <Trash2 size={14} /> Clean…
      </button>
    </div>
  );
}

export function ConfirmSheet() {
  const { confirmOpen, setConfirmOpen, selectedFindings, cleanSelected, cleaning, cleanProgress, settings, updateSettings, isStale } = useStore();
  if (!confirmOpen) return null;
  if (cleaning && cleanProgress) return <CleanProgressSheet p={cleanProgress} toTrash={settings.toTrash} />;
  const total = sum(selectedFindings);
  const heavy = selectedFindings.filter((f) => f.category === "large");
  const active = selectedFindings.filter((f) => f.category !== "global" && f.category !== "large" && !isStale(f.lastActive));
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !cleaning && setConfirmOpen(false)}>
      <div className="sheet glass" role="dialog" aria-modal="true" aria-labelledby="sheet-title" onKeyDown={(e) => e.key === "Escape" && setConfirmOpen(false)}>
        <header>
          <h2 id="sheet-title">Clean {bytes(total)}?</h2>
          <p className="secondary" style={{ margin: "4px 0 0" }}>
            {selectedFindings.length} item{selectedFindings.length > 1 ? "s" : ""}.{" "}
            {settings.toTrash ? "They go to the Recycle Bin, so the space is freed only once you empty it." : "They are deleted permanently. Dependencies and builds come back with the restore command shown."}
          </p>
        </header>
        <div className="sheet-body">
          {heavy.length > 0 && (
            <div className="sub-row" style={{ margin: "8px 0", gap: 8 }}>
              <AlertTriangle size={16} color="var(--warn-line)" />
              <span>
                {heavy.length} heavy file{heavy.length > 1 ? "s are" : " is"} not regenerable — make sure you don't need {heavy.length > 1 ? "them" : "it"}.
              </span>
            </div>
          )}
          {active.length > 0 && (
            <div className="sub-row" style={{ margin: "8px 0", gap: 8 }}>
              <Info size={16} color="var(--text)" />
              <span>{active.length} item{active.length > 1 ? "s belong" : " belongs"} to recently active projects; you'll need to reinstall or rebuild there.</span>
            </div>
          )}
          {CATEGORIES.map((c) => {
            const items = selectedFindings.filter((f) => f.category === c);
            if (!items.length) return null;
            return (
              <div key={c} className="row" style={{ minHeight: 44 }}>
                <span className="dot" style={{ background: CATEGORY[c].color }} />
                <div className="body">
                  <div className="title">{CATEGORY[c].label}</div>
                  <div className="subtitle">{items.length} item{items.length > 1 ? "s" : ""}</div>
                </div>
                <div className="size">{bytes(sum(items))}</div>
              </div>
            );
          })}
        </div>
        <footer>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" className="check" checked={settings.toTrash} onChange={() => updateSettings({ toTrash: !settings.toTrash })} />
            <span className="secondary">Use Recycle Bin</span>
          </label>
          <span className="grow" />
          <button className="btn" onClick={() => setConfirmOpen(false)} disabled={cleaning} autoFocus>
            Cancel
          </button>
          <button className="btn danger" onClick={cleanSelected} disabled={cleaning}>
            <Trash2 size={15} /> {cleaning ? "Cleaning…" : settings.toTrash ? "Move to Recycle Bin" : "Delete permanently"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function CleanProgressSheet({ p, toTrash }: { p: CleanProgress; toTrash: boolean }) {
  const pct = Math.min(100, (p.freed / Math.max(1, p.total)) * 100);
  return (
    <div className="scrim">
      <div className="sheet glass" role="dialog" aria-modal="true" aria-labelledby="progress-title">
        <header>
          <h2 id="progress-title">{toTrash ? "Moving to Recycle Bin…" : "Deleting…"}</h2>
          <p className="secondary" style={{ margin: "4px 0 0" }}>
            Item {Math.min(p.index + 1, p.count)} of {p.count}. You can keep browsing once this finishes.
          </p>
        </header>
        <div style={{ padding: "8px 22px 22px" }}>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Delete progress">
            <span style={{ width: `${pct}%` }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}>
            <span className="num">
              <b>{bytes(p.freed)}</b> <span className="secondary">of {bytes(p.total)}</span>
            </span>
            <b className="num">{Math.round(pct)}%</b>
          </div>
          <div className="current-path" style={{ margin: "8px 0 0" }} title={p.current}>
            {p.current || " "}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useStore();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast glass" role={t.kind === "error" ? "alert" : "status"}>
          {t.kind === "ok" ? <CheckCircle2 size={20} color="var(--ok-line)" /> : t.kind === "error" ? <AlertTriangle size={20} color="var(--danger-line)" /> : <Info size={20} color="var(--text)" />}
          <div className="body">
            <b>{t.title}</b>
            {t.body && <p>{t.body}</p>}
          </div>
          <button className="icon-btn" style={{ width: 24, height: 24 }} aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const { toast } = useStore();
  return (
    <button className="btn sm" onClick={() => navigator.clipboard.writeText(text).then(() => toast({ kind: "info", title: "Copied to clipboard" }))}>
      <Copy size={13} /> {label}
    </button>
  );
}
