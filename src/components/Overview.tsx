import { ArrowRight, Clock, Container, Flame, Sparkles } from "lucide-react";
import { ago, bytes, count } from "../lib/format";
import { CATEGORIES, CATEGORY } from "../lib/meta";
import type { Category } from "../lib/types";
import { useStore, type View } from "../state";
import { AppIcon, FindingRow, sum } from "./ui";

const TARGET: Record<Category, View> = { deps: "projects", build: "projects", cache: "projects", global: "caches", large: "large" };
/** Regenerable, project-local junk — safe to bulk-select for stale projects. */
const REGEN: Category[] = ["deps", "build", "cache"];

export function Overview() {
  const { result, isStale, setMany, setView, docker, settings } = useStore();
  if (!result) return null;
  const f = result.findings;
  const total = sum(f);
  const staleJunk = f.filter((x) => REGEN.includes(x.category) && isStale(x.lastActive));
  const byCat = CATEGORIES.map((c) => ({ c, items: f.filter((x) => x.category === c) }));
  const projectsJunk = result.projects
    .map((p) => ({ p, items: f.filter((x) => x.project === p.path && REGEN.includes(x.category)) }))
    .filter((x) => x.items.length && isStale(x.p.lastActive))
    .sort((a, b) => sum(b.items) - sum(a.items))
    .slice(0, 6);
  const dockerReclaim = docker?.running ? docker.df.reduce((a, r) => a + r.reclaimable, 0) : 0;

  return (
    <>
      <section className="hero glass" aria-label="Reclaimable space">
        <div>
          <div className="kicker">
            <Sparkles size={15} color="var(--accent)" /> Reclaimable dev junk
          </div>
          <div className="big">
            {bytes(total).split(" ")[0]}
            <small>{bytes(total).split(" ")[1]}</small>
          </div>
          <div className="secondary">
            {f.length} items across {result.projects.length} projects · {count(result.files)} files scanned in {(result.durationMs / 1000).toFixed(1)}s
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button className="btn tinted" onClick={() => setView("map")}>
            Disk map
          </button>
          <button className="btn primary" disabled={!staleJunk.length} onClick={() => setMany(staleJunk.map((x) => x.path), true)}>
            <Clock size={15} /> Select stale · {bytes(sum(staleJunk))}
          </button>
        </div>
        <div className="bar thick" role="img" aria-label="Reclaimable space by category">
          {byCat.map(({ c, items }) => {
            const s = sum(items);
            return s ? <span key={c} title={`${CATEGORY[c].label}: ${bytes(s)}`} style={{ width: `${(s / total) * 100}%`, background: CATEGORY[c].color }} /> : null;
          })}
        </div>
        <div className="legend">
          {byCat.map(({ c, items }) => (
            <span key={c}>
              <span className="dot" style={{ background: CATEGORY[c].color }} />
              {CATEGORY[c].label} <b className="num">{bytes(sum(items))}</b>
            </span>
          ))}
        </div>
      </section>

      <div className="grid tiles" style={{ marginTop: 14 }}>
        {byCat.map(({ c, items }) => {
          const m = CATEGORY[c];
          return (
            <button key={c} className="tile glass" onClick={() => setView(TARGET[c])}>
              <AppIcon icon={m.icon} color={m.color} size={30} />
              <div>
                <div className="value">{bytes(sum(items))}</div>
                <div style={{ fontWeight: 600 }}>{m.label}</div>
                <div className="caption">{items.length ? `${items.length} items · ${m.hint}` : "Nothing found"}</div>
              </div>
            </button>
          );
        })}
        {docker?.running && (
          <button className="tile glass" onClick={() => setView("docker")}>
            <AppIcon icon={Container} color="#0a9fd8" size={30} />
            <div>
              <div className="value">{bytes(dockerReclaim)}</div>
              <div style={{ fontWeight: 600 }}>Docker</div>
              <div className="caption">Reclaimable images, cache & volumes</div>
            </div>
          </button>
        )}
      </div>

      <div className="grid cols-2" style={{ marginTop: 6 }}>
        <section>
          <h2 className="list-title">
            <Flame size={14} /> Biggest offenders
          </h2>
          <div className="list glass">
            {f.slice(0, 8).map((x) => (
              <FindingRow key={x.path} f={x} showProject />
            ))}
          </div>
        </section>
        <section>
          <h2 className="list-title">
            <Clock size={14} /> Untouched for {settings.staleDays}+ days
          </h2>
          <div className="list glass">
            {projectsJunk.length === 0 && <div className="row secondary">No stale projects with build junk. Nice.</div>}
            {projectsJunk.map(({ p, items }) => (
              <div key={p.path} className="row clickable" onClick={() => setMany(items.map((i) => i.path), true)} title="Select this project's regenerable junk">
                <span className="dot" style={{ background: "var(--warn)", borderRadius: "50%" }} />
                <div className="body">
                  <div className="title truncate">{p.name}</div>
                  <div className="subtitle truncate">
                    Last touched {ago(p.lastActive)} · {items.map((i) => i.label).join(", ")}
                  </div>
                </div>
                <div className="size">{bytes(sum(items))}</div>
                <ArrowRight size={16} className="muted" />
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
