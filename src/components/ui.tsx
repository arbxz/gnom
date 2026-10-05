import { ChevronRight, Copy, FolderOpen, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, isNative } from "../lib/api";
import { ago, baseName, bytes, relativeTo } from "../lib/format";
import { CATEGORY, STACK_LABEL } from "../lib/meta";
import type { Finding } from "../lib/types";
import { useStore } from "../state";

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <rect x="3" y="3" width="58" height="58" rx="15" strokeWidth={2.5} />
      <path d="M32 13 L45 42 H19 Z" />
      <circle cx="32" cy="12" r="2.5" fill="currentColor" />
      <path d="M17 47 H47" />
    </svg>
  );
}

/** Outlined icon tile; a category passes its pastel as the outline colour. */
export function AppIcon({ icon: Icon, color, size = 26 }: { icon: LucideIcon; color?: string; size?: number }) {
  return (
    <span className="app-icon" style={{ ["--icon-line" as string]: color, width: size, height: size }}>
      <Icon size={Math.round(size * 0.58)} strokeWidth={1.75} aria-hidden="true" />
    </span>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="grow">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children}
    </header>
  );
}

export function Empty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon size={36} strokeWidth={1.6} aria-hidden="true" />
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}

export function Check({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: () => void; label: string }) {
  return (
    <input
      type="checkbox"
      className="check"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate && !checked;
      }}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
    />
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button className="switch" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}

export function Stacks({ stacks }: { stacks: string[] }) {
  return (
    <>
      {stacks.map((s) => (
        <span key={s} className={`chip${s === "tauri" ? " accent" : ""}`}>
          {STACK_LABEL[s] ?? s}
        </span>
      ))}
    </>
  );
}

export function PathActions({ path }: { path: string }) {
  const { toast } = useStore();
  return (
    <div className="actions">
      {isNative && (
        <button className="icon-btn" title="Show in folder" aria-label="Show in folder" onClick={(e) => (e.stopPropagation(), api.reveal(path))}>
          <FolderOpen size={16} />
        </button>
      )}
      <button
        className="icon-btn"
        title="Copy path"
        aria-label="Copy path"
        onClick={(e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(path).then(() => toast({ kind: "info", title: "Path copied" }));
        }}
      >
        <Copy size={15} />
      </button>
    </div>
  );
}

/** One reclaimable item. `base` trims the path to be relative to its project. */
export function FindingRow({ f, base, showProject }: { f: Finding; base?: string | null; showProject?: boolean }) {
  const { selected, toggle, isStale } = useStore();
  const [open, setOpen] = useState(false);
  const meta = CATEGORY[f.category];
  const stale = f.category !== "global" && f.category !== "large" && isStale(f.lastActive);
  const canExpand = f.topFiles.length > 0 || !!f.note;
  return (
    <div className="row-group">
      <div className="row clickable" onClick={() => toggle(f.path)}>
        <Check checked={selected.has(f.path)} onChange={() => toggle(f.path)} label={`Select ${f.path}`} />
        <span className="dot" style={{ background: meta.color }} aria-hidden="true" />
        <div className="body">
          <div className="title">
            <span className="truncate">{f.label}</span>
            {f.tags.includes("tauri") && <span className="chip accent">Tauri</span>}
            {stale && <span className="chip warn">Stale</span>}
          </div>
          <div className="subtitle truncate mono" title={f.path}>
            {showProject && f.project ? `${baseName(f.project)} › ${relativeTo(f.path, f.project)}` : base ? relativeTo(f.path, base) : f.path}
          </div>
          <div className="subtitle truncate">
            {f.category === "large" ? `Modified ${ago(f.lastActive)}` : f.category === "global" ? `${f.files.toLocaleString()} files` : `Project active ${ago(f.lastActive)} · ${f.files.toLocaleString()} files`}
            {f.regen && f.category !== "large" && f.category !== "global" && <> · restore: <span className="mono">{f.regen}</span></>}
          </div>
        </div>
        <PathActions path={f.path} />
        {canExpand ? (
          <button
            className="icon-btn"
            aria-label={open ? "Hide details" : "Show what's inside"}
            aria-expanded={open}
            onClick={(e) => (e.stopPropagation(), setOpen(!open))}
          >
            <ChevronRight size={16} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .2s" }} />
          </button>
        ) : (
          <span style={{ width: 32 }} />
        )}
        <div className="size">{bytes(f.size)}</div>
      </div>
      {open && (
        <div className="sub-rows">
          {f.note && <div className="sub-row secondary" style={{ fontSize: 12.5 }}>{f.note}</div>}
          {f.topFiles.map((t) => (
            <div key={t.path} className="sub-row">
              <span className="truncate mono" style={{ flex: 1 }} title={t.path}>
                {relativeTo(t.path, f.path)}
              </span>
              <span className="num secondary">{bytes(t.size)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function sum(items: { size: number }[]): number {
  return items.reduce((a, b) => a + b.size, 0);
}

/** Header checkbox for a list of findings. */
export function SelectAll({ paths, label }: { paths: string[]; label: string }) {
  const { selected, setMany } = useStore();
  const n = paths.filter((p) => selected.has(p)).length;
  const all = n === paths.length && n > 0;
  return <Check checked={all} indeterminate={n > 0} onChange={() => setMany(paths, !all)} label={label} />;
}
