import { Container, Database, FileWarning, HardDrive, Play, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { bytes } from "../lib/format";
import type { DockerActionKind, DockerImage } from "../lib/types";
import { useStore } from "../state";
import { CopyButton } from "./Shell";
import { Check, Empty, FindingRow, PageHead, Segmented, SelectAll, Switch, sum } from "./ui";

export function Caches() {
  const { result, toast } = useStore();
  const [running, setRunning] = useState<string | null>(null);
  const items = result?.findings.filter((f) => f.category === "global") ?? [];
  const withCmd = items.filter((f) => f.commandId);
  const run = (id: string, label: string) => {
    setRunning(id);
    api
      .runCacheCommand(id)
      .then((out) => toast({ kind: "ok", title: `${label} cleaned`, body: out.slice(0, 240) || "Done. Rescan to see the new size." }))
      .catch((e) => toast({ kind: "error", title: `${label}: command failed`, body: String(e).slice(0, 300) }))
      .finally(() => setRunning(null));
  };
  return (
    <>
      <PageHead title="Package caches" sub={`${bytes(sum(items))} of downloaded packages, toolchains and browsers shared by all your projects.`} />
      {withCmd.length > 0 && (
        <>
          <h2 className="list-title">Gentle clean · official commands</h2>
          <div className="list glass">
            {withCmd.map((f) => (
              <div key={f.path} className="row">
                <Play size={16} className="muted" />
                <div className="body">
                  <div className="title">{f.label}</div>
                  <div className="subtitle mono">{f.command}</div>
                </div>
                <div className="size">{bytes(f.size)}</div>
                <button className="btn sm tinted" disabled={running !== null} onClick={() => run(f.commandId!, f.label)}>
                  {running === f.commandId ? "Running…" : "Run"}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      <h2 className="list-title">
        <SelectAll paths={items.map((i) => i.path)} label="Select all caches" /> Delete cache folders
      </h2>
      <div className="list glass">
        {items.length === 0 ? (
          <Empty icon={Database} title="No package caches found" />
        ) : (
          items.map((f) => <FindingRow key={f.path} f={f} />)
        )}
      </div>
    </>
  );
}

export function LargeFiles() {
  const { result, settings } = useStore();
  const items = result?.findings.filter((f) => f.category === "large") ?? [];
  const reasons = [...new Set(items.map((i) => i.label))];
  const [reason, setReason] = useState("all");
  const shown = reason === "all" ? items : items.filter((i) => i.label === reason);
  return (
    <>
      <PageHead title="Heavy files" sub={`Files over ${settings.largeFileMb} MB living inside projects — recordings, dumps, weights, archives. Not regenerable, so review each one.`} />
      {reasons.length > 1 && (
        <div style={{ marginBottom: 12, overflowX: "auto" }}>
          <Segmented label="File type" value={reason} onChange={setReason} options={[{ value: "all", label: "All" }, ...reasons.map((r) => ({ value: r, label: r }))]} />
        </div>
      )}
      <div className="list glass">
        {shown.length === 0 ? (
          <Empty icon={FileWarning} title="No heavy files">
            Nothing over {settings.largeFileMb} MB inside your projects.
          </Empty>
        ) : (
          shown.map((f) => <FindingRow key={f.path} f={f} showProject />)
        )}
      </div>
    </>
  );
}

const DF_ACTION: Record<string, { kind: DockerActionKind; label: string }> = {
  Images: { kind: "pruneDangling", label: "Prune dangling" },
  Containers: { kind: "pruneContainers", label: "Prune stopped" },
  "Local Volumes": { kind: "pruneVolumes", label: "Prune unused" },
  "Build Cache": { kind: "pruneBuildCache", label: "Prune cache" },
};

export function Docker() {
  const { docker, dockerLoading, loadDocker, toast } = useStore();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const act = (kind: DockerActionKind, ids: string[] = [], label = "Done") => {
    setBusy(true);
    api
      .dockerAction(kind, ids)
      .then((out) => {
        toast({ kind: "ok", title: label, body: out.trim().split("\n").slice(-1)[0] });
        setSel(new Set());
        loadDocker();
      })
      .catch((e) => toast({ kind: "error", title: "Docker command failed", body: String(e).slice(0, 300) }))
      .finally(() => setBusy(false));
  };

  const head = (
    <PageHead title="Docker" sub={docker?.version ? `Engine ${docker.version}` : "Images, containers, volumes and build cache"}>
      <button className="btn sm" onClick={loadDocker} disabled={dockerLoading}>
        <RefreshCw size={14} /> Refresh
      </button>
    </PageHead>
  );
  if (!docker || !docker.running) {
    return (
      <>
        {head}
        <div className="glass list">
          <Empty icon={Container} title={dockerLoading ? "Asking Docker…" : docker?.installed ? "Docker isn't running" : "Docker not found"}>
            {dockerLoading ? null : docker?.error ?? "Start Docker Desktop, then refresh."}
          </Empty>
        </div>
        {docker && <VirtualDisks />}
      </>
    );
  }
  const unused = docker.images.filter((i) => !i.inUse);
  const toggle = (id: string) => setSel((s) => (s.has(id) ? (s.delete(id), new Set(s)) : new Set(s.add(id))));
  const selSize = docker.images.filter((i) => sel.has(i.id)).reduce((a, i) => a + i.size, 0);
  return (
    <>
      {head}
      <div className="grid tiles">
        {docker.df.map((r) => (
          <div key={r.kind} className="tile glass" style={{ cursor: "default" }}>
            <div className="caption">{r.kind}</div>
            <div className="value">{bytes(r.size)}</div>
            <div className="caption">
              {r.active}/{r.total} active · <b style={{ color: "var(--text-2)" }}>{bytes(r.reclaimable)}</b> reclaimable
            </div>
            {DF_ACTION[r.kind] && (
              <button className="btn sm danger-tinted" disabled={busy || !r.reclaimable} onClick={() => act(DF_ACTION[r.kind].kind, [], `${r.kind} pruned`)}>
                {DF_ACTION[r.kind].label}
              </button>
            )}
          </div>
        ))}
      </div>
      <h2 className="list-title" style={{ justifyContent: "space-between" }}>
        <span>Images · {unused.length} not used by any container</span>
        {sel.size > 0 && (
          <button className="btn sm danger" disabled={busy} onClick={() => act("removeImages", [...sel], `Removed ${sel.size} image${sel.size > 1 ? "s" : ""}`)}>
            <Trash2 size={13} /> Remove {sel.size} · {bytes(selSize)}
          </button>
        )}
      </h2>
      <div className="list glass">
        {docker.images.length === 0 && <Empty icon={Container} title="No images" />}
        {docker.images.map((i) => (
          <ImageRow key={i.id} i={i} checked={sel.has(i.id)} onToggle={() => toggle(i.id)} />
        ))}
      </div>
      {docker.containers.length > 0 && (
        <>
          <h2 className="list-title">Containers</h2>
          <div className="list glass">
            {docker.containers.map((c) => (
              <div key={c.id} className="row">
                <span className="dot" style={{ borderRadius: "50%", background: c.state === "running" ? "var(--ok)" : "var(--text-3)" }} />
                <div className="body">
                  <div className="title">{c.name}</div>
                  <div className="subtitle mono">{c.image}</div>
                </div>
                <span className="secondary">{c.status}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <VirtualDisks />
    </>
  );
}

function ImageRow({ i, checked, onToggle }: { i: DockerImage; checked: boolean; onToggle: () => void }) {
  const old = /year|month/.test(i.createdSince) && !/^[1-2] months?/.test(i.createdSince);
  return (
    <div className="row clickable" onClick={i.inUse ? undefined : onToggle}>
      {i.inUse ? <span style={{ width: 22 }} /> : <Check checked={checked} onChange={onToggle} label={`Select ${i.repo}:${i.tag}`} />}
      <Container size={18} className="muted" />
      <div className="body">
        <div className="title">
          <span className="truncate mono">{i.dangling ? i.id.replace("sha256:", "").slice(0, 12) : `${i.repo}:${i.tag}`}</span>
          {i.dangling && <span className="chip danger">Dangling</span>}
          {i.inUse ? <span className="chip ok">In use</span> : <span className="chip">Unused</span>}
          {!i.inUse && old && <span className="chip warn">Stale</span>}
        </div>
        <div className="subtitle">Created {i.createdSince}</div>
      </div>
      <div className="size">{bytes(i.size)}</div>
    </div>
  );
}

function VirtualDisks() {
  const { docker } = useStore();
  if (!docker?.disks.length) return null;
  return (
    <>
      <h2 className="list-title">
        <HardDrive size={14} /> WSL virtual disks
      </h2>
      <div className="card glass">
        <p className="sub" style={{ marginBottom: 8 }}>
          Docker Desktop and WSL store data in .vhdx files that grow but <b>never shrink on their own</b>. After pruning, compact them to give the space back to Windows.
        </p>
        {docker.disks.map((d) => (
          <div key={d.path} className="sub-row" style={{ marginBottom: 6 }}>
            <div className="body" style={{ flex: 1, minWidth: 0 }}>
              <b>{d.label}</b>
              <div className="mono muted truncate">{d.path}</div>
            </div>
            <span className="num" style={{ fontWeight: 650 }}>
              {bytes(d.size)}
            </span>
          </div>
        ))}
        <pre className="snippet">{`# Quit Docker Desktop, then in an admin terminal:
wsl --shutdown
diskpart
  select vdisk file="${docker.disks[0].path}"
  attach vdisk readonly
  compact vdisk
  detach vdisk
  exit`}</pre>
        <div style={{ marginTop: 8 }}>
          <CopyButton text={`wsl --shutdown\ndiskpart\nselect vdisk file="${docker.disks[0].path}"\nattach vdisk readonly\ncompact vdisk\ndetach vdisk\nexit`} label="Copy steps" />
        </div>
      </div>
    </>
  );
}

export function SettingsView() {
  const { settings, updateSettings } = useStore();
  const [root, setRoot] = useState("");
  const [ex, setEx] = useState("");
  const addTo = (key: "roots" | "exclude", v: string, reset: () => void) => {
    const p = v.trim().replace(/^"|"$/g, "");
    if (p && !settings[key].includes(p)) updateSettings({ [key]: [...settings[key], p] });
    reset();
  };
  const pathList = (key: "roots" | "exclude", value: string, set: (v: string) => void, placeholder: string) => (
    <>
      {settings[key].map((p) => (
        <div key={p} className="settings-row">
          <div className="body mono truncate">{p}</div>
          <button className="icon-btn" aria-label={`Remove ${p}`} onClick={() => updateSettings({ [key]: settings[key].filter((x) => x !== p) })}>
            <X size={15} />
          </button>
        </div>
      ))}
      <form
        className="settings-row"
        onSubmit={(e) => {
          e.preventDefault();
          addTo(key, value, () => set(""));
        }}
      >
        <input className="field mono" style={{ flex: 1 }} placeholder={placeholder} value={value} onChange={(e) => set(e.target.value)} aria-label={placeholder} />
        <button className="btn sm" type="submit" disabled={!value.trim()}>
          <Plus size={14} /> Add
        </button>
      </form>
    </>
  );
  return (
    <>
      <PageHead title="Settings" sub="Saved on this machine." />
      <h2 className="list-title">Scan locations</h2>
      <div className="list glass">{pathList("roots", root, setRoot, "Folder to scan, e.g. D:\\dev")}</div>
      <h2 className="list-title">Never scan</h2>
      <div className="list glass">{pathList("exclude", ex, setEx, "Folder to skip entirely")}</div>
      <h2 className="list-title">Rules</h2>
      <div className="list glass">
        <div className="settings-row">
          <div className="body">
            Stale after
            <small>Projects with no file changes for this long are flagged stale.</small>
          </div>
          <Segmented label="Stale after" value={settings.staleDays} onChange={(v) => updateSettings({ staleDays: v })} options={[14, 30, 60, 90, 180].map((d) => ({ value: d, label: `${d}d` }))} />
        </div>
        <div className="settings-row">
          <div className="body">
            Heavy file threshold
            <small>Files above this size inside projects are listed. Applies on next scan.</small>
          </div>
          <Segmented label="Heavy file threshold" value={settings.largeFileMb} onChange={(v) => updateSettings({ largeFileMb: v })} options={[100, 200, 500, 1024].map((m) => ({ value: m, label: m >= 1024 ? "1 GB" : `${m} MB` }))} />
        </div>
        <div className="settings-row">
          <div className="body">
            Use Recycle Bin
            <small>Safer, but slow for huge folders like node_modules, and space is freed only when you empty the bin.</small>
          </div>
          <Switch label="Use Recycle Bin" on={settings.toTrash} onChange={(v) => updateSettings({ toTrash: v })} />
        </div>
      </div>
      <h2 className="list-title">Appearance</h2>
      <div className="list glass">
        <div className="settings-row">
          <div className="body">Theme</div>
          <Segmented
            label="Theme"
            value={settings.theme}
            onChange={(v) => updateSettings({ theme: v })}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </div>
        <div className="settings-row">
          <div className="body">
            Reduce transparency
            <small>Solid panels instead of blurred glass. Faster on machines without a GPU.</small>
          </div>
          <Switch label="Reduce transparency" on={settings.solid} onChange={(v) => updateSettings({ solid: v })} />
        </div>
      </div>
    </>
  );
}
