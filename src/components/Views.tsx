import { AlertTriangle, Container, Database, FileWarning, HardDrive, Play, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { appVersion, checkForUpdates } from "../lib/updater";
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

/** A docker action waiting for the user to confirm it in a sheet. */
interface Pending {
  kind: DockerActionKind;
  ids: string[];
  names: string[];
  title: string;
  body: string;
  warn?: string;
  confirm: string;
  done: string;
}

/** Only the two prunes that touch nothing but rebuildable data get a one-step action. */
const PRUNE: Record<string, Omit<Pending, "ids" | "names">> = {
  Images: {
    kind: "pruneDangling",
    title: "Prune dangling images?",
    body: "Removes untagged images that no container uses. Tagged images are kept.",
    confirm: "Prune dangling",
    done: "Dangling images pruned",
  },
  "Build Cache": {
    kind: "pruneBuildCache",
    title: "Clear the build cache?",
    body: "Removes cached build layers that no image needs. Your next builds take longer while it refills.",
    confirm: "Clear cache",
    done: "Build cache cleared",
  },
};

const short = (id: string) => id.replace("sha256:", "").slice(0, 12);
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;
const STOPPED = new Set(["exited", "created", "dead"]);
const DB_IMAGE = /postgres|mysql|mariadb|mongo|redis|elastic|opensearch|clickhouse|cassandra|neo4j|influx|couch|db/i;

function useToggleSet() {
  const [set, setSet] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setSet((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  return [set, toggle, () => setSet(new Set())] as const;
}

export function Docker() {
  const { docker, dockerLoading, loadDocker, toast } = useStore();
  const [selImg, toggleImg, clearImg] = useToggleSet();
  const [selCon, toggleCon, clearCon] = useToggleSet();
  const [selVol, toggleVol, clearVol] = useToggleSet();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (p: Pending) => {
    setBusy(true);
    api
      .dockerAction(p.kind, p.ids)
      .then((out) => {
        toast({ kind: "ok", title: p.done, body: out.trim().split("\n").slice(-1)[0] });
        clearImg();
        clearCon();
        clearVol();
        loadDocker();
      })
      .catch((e) => toast({ kind: "error", title: "Docker command failed", body: String(e).slice(0, 300) }))
      .finally(() => {
        setBusy(false);
        setPending(null);
      });
  };

  const head = (
    <PageHead
      title="Containers"
      sub={docker?.running ? `${docker.engine} ${docker.version}` : "Docker Desktop, OrbStack, Rancher Desktop or Podman: images, containers, volumes and build cache"}
    >
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
          <Empty
            icon={Container}
            title={dockerLoading ? "Looking for a container engine…" : docker?.installed ? `${docker.engine ?? "The engine"} isn't running` : "No container engine found"}
          >
            {dockerLoading ? null : docker?.error ?? "Start Docker Desktop, OrbStack, Rancher Desktop or your Podman machine, then refresh."}
          </Empty>
        </div>
        {docker && <VirtualDisks />}
      </>
    );
  }
  const unused = docker.images.filter((i) => !i.inUse);
  const pickedImages = docker.images.filter((i) => selImg.has(i.id));
  const stopped = docker.containers.filter((c) => STOPPED.has(c.state));
  const pickedContainers = docker.containers.filter((c) => selCon.has(c.id));
  const volumes = docker.volumes ?? [];
  const freeVolumes = volumes.filter((v) => !v.inUse);
  const pickedVolumes = volumes.filter((v) => selVol.has(v.name));
  const volSize = sum(pickedVolumes);

  const askImages = () =>
    setPending({
      kind: "removeImages",
      ids: pickedImages.map((i) => i.id),
      names: pickedImages.map((i) => (i.dangling ? short(i.id) : `${i.repo}:${i.tag}`)),
      title: `Remove ${plural(pickedImages.length, "image")} · ${bytes(sum(pickedImages))}?`,
      body: "You can pull or rebuild them later. Your engine refuses any image a container still uses.",
      confirm: "Remove images",
      done: `Removed ${plural(pickedImages.length, "image")}`,
    });
  const askContainers = () => {
    const dbs = pickedContainers.filter((c) => DB_IMAGE.test(c.image));
    setPending({
      kind: "removeContainers",
      ids: pickedContainers.map((c) => c.id),
      names: pickedContainers.map((c) => `${c.name} · ${c.image}`),
      title: `Remove ${plural(pickedContainers.length, "stopped container")}?`,
      body: "Anything written inside a container, outside its volumes, is lost. Volumes are kept and stay listed under Volumes.",
      warn: dbs.length
        ? `${dbs.map((c) => c.name).join(", ")} ${dbs.length > 1 ? "look like databases" : "looks like a database"}. Data kept without a volume goes too.`
        : undefined,
      confirm: "Remove containers",
      done: `Removed ${plural(pickedContainers.length, "container")}`,
    });
  };
  const askVolumes = () => {
    const named = pickedVolumes.filter((v) => !v.anonymous);
    setPending({
      kind: "removeVolumes",
      ids: pickedVolumes.map((v) => v.name),
      names: pickedVolumes.map((v) => (v.anonymous ? `${short(v.name)} (anonymous)` : v.name)),
      title: `Delete ${plural(pickedVolumes.length, "volume")}${volSize ? ` · ${bytes(volSize)}` : ""}?`,
      body: "Volumes hold databases, uploads and anything else containers keep. This cannot be undone.",
      warn: named.length
        ? `Named volumes are usually created on purpose, often by a compose project you may start again: ${named.map((v) => v.name).join(", ")}.`
        : undefined,
      confirm: "Delete volumes",
      done: `Deleted ${plural(pickedVolumes.length, "volume")}`,
    });
  };

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
            {PRUNE[r.kind] && (
              <button className="btn sm danger-tinted" disabled={busy || !r.reclaimable} onClick={() => setPending({ ...PRUNE[r.kind], ids: [], names: [] })}>
                {PRUNE[r.kind].confirm}
              </button>
            )}
          </div>
        ))}
      </div>

      <h2 className="list-title" style={{ justifyContent: "space-between" }}>
        <span>Images · {unused.length} not used by any container</span>
        {selImg.size > 0 && (
          <button className="btn sm danger" disabled={busy} onClick={askImages}>
            <Trash2 size={13} /> Remove {selImg.size} · {bytes(sum(pickedImages))}
          </button>
        )}
      </h2>
      <div className="list glass">
        {docker.images.length === 0 && <Empty icon={Container} title="No images" />}
        {docker.images.map((i) => (
          <ImageRow key={i.id} i={i} checked={selImg.has(i.id)} onToggle={() => toggleImg(i.id)} />
        ))}
      </div>

      {docker.containers.length > 0 && (
        <>
          <h2 className="list-title" style={{ justifyContent: "space-between" }}>
            <span>Containers · {stopped.length} stopped</span>
            {selCon.size > 0 && (
              <button className="btn sm danger" disabled={busy} onClick={askContainers}>
                <Trash2 size={13} /> Remove {selCon.size}
              </button>
            )}
          </h2>
          <div className="list glass">
            {docker.containers.map((c) => {
              const removable = STOPPED.has(c.state);
              return (
                <div key={c.id} className={`row${removable ? " clickable" : ""}`} onClick={removable ? () => toggleCon(c.id) : undefined}>
                  {removable ? <Check checked={selCon.has(c.id)} onChange={() => toggleCon(c.id)} label={`Select ${c.name}`} /> : <span style={{ width: 22 }} />}
                  <span className="dot" style={{ borderRadius: "50%", background: c.state === "running" ? "var(--ok-line)" : "var(--text-3)" }} />
                  <div className="body">
                    <div className="title">
                      <span className="truncate">{c.name}</span>
                      {removable && DB_IMAGE.test(c.image) && <span className="chip warn">Database?</span>}
                    </div>
                    <div className="subtitle mono">{c.image}</div>
                  </div>
                  <span className="secondary">{c.status}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {volumes.length > 0 && (
        <>
          <h2 className="list-title" style={{ justifyContent: "space-between" }}>
            <span>Volumes · {freeVolumes.length} not used by any container</span>
            {selVol.size > 0 && (
              <button className="btn sm danger" disabled={busy} onClick={askVolumes}>
                <Trash2 size={13} /> Delete {selVol.size}
                {volSize ? ` · ${bytes(volSize)}` : ""}
              </button>
            )}
          </h2>
          <div className="list glass">
            {volumes.map((v) => (
              <div key={v.name} className={`row${v.inUse ? "" : " clickable"}`} onClick={v.inUse ? undefined : () => toggleVol(v.name)}>
                {v.inUse ? <span style={{ width: 22 }} /> : <Check checked={selVol.has(v.name)} onChange={() => toggleVol(v.name)} label={`Select volume ${v.name}`} />}
                <Database size={18} className="muted" />
                <div className="body">
                  <div className="title">
                    <span className="truncate mono">{v.anonymous ? short(v.name) : v.name}</span>
                    {v.anonymous && <span className="chip">Anonymous</span>}
                    {v.inUse ? <span className="chip ok">In use</span> : <span className="chip">Unused</span>}
                  </div>
                  <div className="subtitle">{v.inUse ? "Attached to a container" : "No container refers to it, but it may still hold data"}</div>
                </div>
                <div className="size">{v.size ? bytes(v.size) : "–"}</div>
              </div>
            ))}
          </div>
        </>
      )}
      <VirtualDisks />
      {pending && <DockerSheet p={pending} busy={busy} onCancel={() => setPending(null)} onConfirm={() => run(pending)} />}
    </>
  );
}

function DockerSheet({ p, busy, onCancel, onConfirm }: { p: Pending; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="sheet glass" role="dialog" aria-modal="true" aria-labelledby="docker-sheet-title" onKeyDown={(e) => e.key === "Escape" && !busy && onCancel()}>
        <header>
          <h2 id="docker-sheet-title">{p.title}</h2>
          <p className="secondary" style={{ margin: "4px 0 0" }}>
            {p.body}
          </p>
        </header>
        <div className="sheet-body">
          {p.warn && (
            <div className="sub-row" style={{ margin: "8px 0", gap: 8 }}>
              <AlertTriangle size={16} color="var(--warn-line)" style={{ flexShrink: 0 }} />
              <span>{p.warn}</span>
            </div>
          )}
          {p.names.map((n) => (
            <div key={n} className="row" style={{ minHeight: 40 }}>
              <div className="body">
                <div className="title">
                  <span className="truncate mono">{n}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
        <footer>
          <span className="grow" />
          <button className="btn" onClick={onCancel} disabled={busy} autoFocus>
            Cancel
          </button>
          <button className="btn danger" onClick={onConfirm} disabled={busy}>
            <Trash2 size={15} /> {busy ? "Working…" : p.confirm}
          </button>
        </footer>
      </div>
    </div>
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
  // Only WSL disks have Windows paths, and only they need compacting by hand.
  if (!docker.disks[0].path.includes("\\")) {
    return (
      <>
        <h2 className="list-title">
          <HardDrive size={14} /> Virtual disks
        </h2>
        <div className="card glass">
          <p className="sub" style={{ marginBottom: 8 }}>
            Your container engine keeps its data in a sparse disk image, shown here at the space it really uses. gnom never deletes these. Space freed by pruning goes back to macOS by itself, sometimes after a few minutes.
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
        </div>
      </>
    );
  }
  return (
    <>
      <h2 className="list-title">
        <HardDrive size={14} /> WSL virtual disks
      </h2>
      <div className="card glass">
        <p className="sub" style={{ marginBottom: 8 }}>
          Docker Desktop, Rancher Desktop, Podman and every WSL distro store their data in .vhdx files that grow but <b>never shrink on their own</b>. gnom never deletes them. After pruning, compact one to give the space back to Windows.
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
        <pre className="snippet">{`# Quit Docker Desktop, Rancher Desktop or Podman, then in an admin terminal:
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
  const { settings, updateSettings, toast } = useStore();
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void appVersion().then(setVersion);
  }, []);

  const onCheckUpdates = async () => {
    setChecking(true);
    try {
      await checkForUpdates({ silent: false, toast });
    } finally {
      setChecking(false);
    }
  };

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
      <h2 className="list-title">About</h2>
      <div className="list glass">
        <div className="settings-row">
          <div className="body">
            gnom {version ?? ""}
            <small>Updates are signed and verified before they install.</small>
          </div>
          <button className="btn sm tinted" onClick={onCheckUpdates} disabled={checking}>
            <RefreshCw size={14} className={checking ? "spin" : ""} />
            {checking ? "Checking…" : "Check for updates"}
          </button>
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
