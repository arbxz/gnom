import { ChevronRight, Folder, FolderGit2, PackageSearch, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { ago, bytes } from "../lib/format";
import { CATEGORIES, CATEGORY } from "../lib/meta";
import type { DepReport, Finding, Project } from "../lib/types";
import { useStore } from "../state";
import { CopyButton } from "./Shell";
import { Empty, FindingRow, PageHead, PathActions, Segmented, SelectAll, Stacks, sum } from "./ui";

type Filter = "all" | "stale" | "active";
type Sort = "size" | "recent" | "name";

export function Projects() {
  const { result, isStale, settings } = useStore();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("size");

  const rows = useMemo(() => {
    if (!result) return [];
    const byProject = new Map<string, Finding[]>();
    for (const f of result.findings) {
      if (f.project && f.category !== "global") byProject.set(f.project, [...(byProject.get(f.project) ?? []), f]);
    }
    return result.projects.map((p) => ({ p, items: byProject.get(p.path) ?? [] })).filter((r) => r.items.length);
  }, [result]);

  const shown = rows
    .filter(({ p }) => (filter === "all" ? true : filter === "stale" ? isStale(p.lastActive) : !isStale(p.lastActive)))
    .filter(({ p }) => !q || p.path.toLowerCase().includes(q.toLowerCase()) || p.stacks.some((s) => s.includes(q.toLowerCase())))
    .sort((a, b) => (sort === "size" ? sum(b.items) - sum(a.items) : sort === "recent" ? (b.p.lastActive ?? 0) - (a.p.lastActive ?? 0) : a.p.name.localeCompare(b.p.name)));

  const clean = (result?.projects.length ?? 0) - rows.length;
  return (
    <>
      <PageHead title="Projects" sub={`${rows.length} projects hold ${bytes(sum(rows.flatMap((r) => r.items)))} of regenerable or heavy stuff${clean ? ` · ${clean} are already clean` : ""}.`} />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <label className="search">
          <Search size={15} aria-hidden="true" />
          <input placeholder="Filter by path or stack (e.g. tauri)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter projects" />
        </label>
        <Segmented<Filter>
          label="Activity filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "stale", label: `Stale ${settings.staleDays}d+` },
            { value: "active", label: "Active" },
          ]}
        />
        <Segmented<Sort>
          label="Sort"
          value={sort}
          onChange={setSort}
          options={[
            { value: "size", label: "Largest" },
            { value: "recent", label: "Recent" },
            { value: "name", label: "Name" },
          ]}
        />
      </div>
      {shown.length === 0 ? (
        <div className="glass list">
          <Empty icon={FolderGit2} title="No matching projects">
            Try another filter.
          </Empty>
        </div>
      ) : (
        <div className="list glass">
          {shown.map(({ p, items }) => (
            <ProjectRow key={p.path} p={p} items={items} />
          ))}
        </div>
      )}
    </>
  );
}

function ProjectRow({ p, items }: { p: Project; items: Finding[] }) {
  const { isStale } = useStore();
  const [open, setOpen] = useState(false);
  const junk = sum(items);
  const stale = isStale(p.lastActive);
  // Heavy files are never bulk-selected: they are not regenerable.
  const regen = items.filter((i) => i.category !== "large").map((i) => i.path);
  return (
    <div className="row-group">
      <div className="row clickable" onClick={() => setOpen(!open)} aria-expanded={open}>
        {regen.length ? <SelectAll paths={regen} label={`Select regenerable junk in ${p.name}`} /> : <span style={{ width: 22 }} />}
        <Folder size={20} color={stale ? "var(--warn)" : "var(--accent)"} fill="currentColor" fillOpacity={0.18} aria-hidden="true" />
        <div className="body">
          <div className="title">
            <span className="truncate">{p.name}</span>
            <Stacks stacks={p.stacks} />
            {stale && <span className="chip warn">Stale</span>}
          </div>
          <div className="subtitle truncate mono">{p.path}</div>
          <div className="subtitle">
            Active {ago(p.lastActive)} · {bytes(junk)} of {bytes(p.size)} is junk
          </div>
        </div>
        <div className="proj-bar" aria-hidden="true">
          <div className="bar">
            {CATEGORIES.map((c) => {
              const s = sum(items.filter((i) => i.category === c));
              return s ? <span key={c} style={{ width: `${(s / Math.max(p.size, junk)) * 100}%`, background: CATEGORY[c].color }} /> : null;
            })}
          </div>
        </div>
        <PathActions path={p.path} />
        <ChevronRight size={16} className="muted" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .2s" }} />
        <div className="size">{bytes(junk)}</div>
      </div>
      {open && (
        <div style={{ paddingLeft: 34 }}>
          {items.map((f) => (
            <FindingRow key={f.path} f={f} base={p.path} />
          ))}
          {p.stacks.includes("node") && <DepsPanel project={p.path} />}
        </div>
      )}
    </div>
  );
}

function DepsPanel({ project }: { project: string }) {
  const { toast } = useStore();
  const [report, setReport] = useState<DepReport | null>(null);
  const [busy, setBusy] = useState(false);
  const run = () => {
    setBusy(true);
    api
      .checkDeps(project)
      .then(setReport)
      .catch((e) => toast({ kind: "error", title: "Dependency check failed", body: String(e) }))
      .finally(() => setBusy(false));
  };
  const unused = report?.deps.filter((d) => !d.used).sort((a, b) => b.size - a.size) ?? [];
  return (
    <div className="sub-rows" style={{ paddingTop: 8 }}>
      {!report ? (
        <div className="sub-row">
          <PackageSearch size={16} className="muted" />
          <span style={{ flex: 1 }} className="secondary">
            Look for npm packages declared in package.json that nothing imports.
          </span>
          <button className="btn sm tinted" onClick={run} disabled={busy}>
            {busy ? "Checking…" : "Find unused deps"}
          </button>
        </div>
      ) : unused.length === 0 ? (
        <div className="sub-row secondary">All {report.deps.length} declared packages are referenced ({report.scannedFiles} files checked).</div>
      ) : (
        <>
          <div className="sub-row" style={{ flexWrap: "wrap" }}>
            <span style={{ flex: 1 }}>
              <b>{unused.length} possibly unused</b> <span className="secondary">of {report.deps.length} · {bytes(sum(unused))} in node_modules · verify before removing</span>
            </span>
            <CopyButton text={`${report.manager} remove ${unused.map((d) => d.name).join(" ")}`} label="Copy remove command" />
          </div>
          {unused.map((d) => (
            <div key={d.name} className="sub-row">
              <span className="mono" style={{ flex: 1 }}>
                {d.name}
              </span>
              {d.dev && <span className="chip">dev</span>}
              <span className="num secondary">{bytes(d.size)}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
