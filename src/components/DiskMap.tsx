import { hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode } from "d3-hierarchy";
import { ChevronRight, LayoutGrid, MousePointerClick } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { bytes } from "../lib/format";
import { CATEGORIES, CATEGORY } from "../lib/meta";
import type { Category, TreeNode } from "../lib/types";
import { useStore } from "../state";
import { Empty, PageHead, sum } from "./ui";

interface Cell {
  key: string;
  name: string;
  size: number;
  node: TreeNode | null; // null = the "everything else" remainder
  category: Category | null;
  kids?: Cell[];
  /** For collapsed folders: how much junk hides inside, and its dominant kind. */
  junk?: { size: number; category: Category };
}

/** How many children each nesting level may show; the rest folds into a hatched remainder. */
const LEVEL_CAP = [36, 10, 5];
const MIN_SHARE = 0.003;

function toCells(n: TreeNode, depth: number, total: number): Cell {
  const cell: Cell = { key: n.path, name: n.name, size: n.size, node: n, category: n.category };
  const collapsed = () => {
    if (n.category || !n.children.length) return cell;
    const j = junkUnder(n, { deps: 0, build: 0, cache: 0, global: 0, large: 0 });
    const [category] = (Object.entries(j) as [Category, number][]).sort((a, b) => b[1] - a[1])[0];
    const inside = Object.values(j).reduce((a, b) => a + b, 0);
    return inside > 0 ? { ...cell, junk: { size: inside, category } } : cell;
  };
  if (depth >= LEVEL_CAP.length || !n.children.length || n.category) return collapsed();
  const shown = n.children.filter((c) => c.size / total >= MIN_SHARE).slice(0, LEVEL_CAP[depth]);
  if (!shown.length) return collapsed();
  const kids = shown.map((c) => toCells(c, depth + 1, total));
  const rest = n.size - sum(shown);
  if (rest / total >= MIN_SHARE / 2) kids.push({ key: `${n.path}::rest`, name: "other files", size: rest, node: null, category: null });
  return { ...cell, kids };
}

function junkUnder(n: TreeNode, acc: Record<Category, number>) {
  if (n.category) acc[n.category] += n.size;
  else n.children.forEach((c) => junkUnder(c, acc));
  return acc;
}

function tileBackground(c: Cell, frame: boolean): string | undefined {
  if (frame) return undefined;
  if (c.category) return CATEGORY[c.category].color;
  if (!c.junk) return undefined;
  // Fill from the bottom with the junk share, so deep target/ and node_modules still show.
  const pct = Math.min(100, (c.junk.size / Math.max(1, c.size)) * 100);
  const color = CATEGORY[c.junk.category].color;
  return `linear-gradient(to top, color-mix(in srgb, ${color} 80%, transparent) ${pct}%, var(--c-none) ${pct}%)`;
}

export function DiskMap() {
  const { result, selected, setMany, isStale } = useStore();
  const root = useMemo<TreeNode | null>(() => {
    if (!result?.tree.length) return null;
    if (result.tree.length === 1) return result.tree[0];
    return { name: "All locations", path: "", size: sum(result.tree), category: null, children: result.tree };
  }, [result]);
  const [trail, setTrail] = useState<string[]>([]);
  const focus = useMemo(() => {
    let n = root;
    for (const p of trail) n = n?.children.find((c) => c.path === p) ?? n;
    return n;
  }, [root, trail]);

  const box = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setDims({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [focus]);

  const leaves = useMemo(() => {
    if (!focus || !dims.w || !dims.h) return [];
    const data = toCells(focus, 0, Math.max(1, focus.size));
    const h = hierarchy<Cell>(data, (d) => d.kids).sum((d) => (d.kids ? 0 : Math.max(0, d.size)));
    const laid = treemap<Cell>().tile(treemapSquarify.ratio(1.2)).size([dims.w, dims.h]).paddingInner(3).paddingOuter(3).paddingTop((d) => (d.depth > 0 && d.children ? 20 : 3)).round(true)(h);
    return laid.descendants().slice(1);
  }, [focus, dims]);

  const [tip, setTip] = useState<{ x: number; y: number; d: HierarchyRectangularNode<Cell> } | null>(null);

  if (!root || !focus) {
    return (
      <>
        <PageHead title="Disk map" />
        <div className="glass list">
          <Empty icon={LayoutGrid} title="Nothing mapped yet">
            Run a scan first.
          </Empty>
        </div>
      </>
    );
  }

  const zoom = (n: TreeNode | null) => {
    if (!n || !n.children.length || n.category) return;
    // Rebuild the trail from root to n using path prefixes.
    const path: string[] = [];
    let cur: TreeNode | undefined = focus;
    const chain = [...trail];
    while (cur && cur !== n) {
      const next: TreeNode | undefined = cur.children.find((c) => n.path === c.path || n.path.startsWith(c.path + "\\") || n.path.startsWith(c.path + "/"));
      if (!next) break;
      path.push(next.path);
      cur = next;
    }
    setTrail([...chain, ...path]);
    setTip(null);
  };
  const crumbs: TreeNode[] = [root];
  for (const p of trail) {
    const n = crumbs[crumbs.length - 1].children.find((c) => c.path === p);
    if (n) crumbs.push(n);
  }

  const junk = junkUnder(focus, { deps: 0, build: 0, cache: 0, global: 0, large: 0 });
  const totalJunk = Object.values(junk).reduce((a, b) => a + b, 0);
  const prefix = focus.path.toLowerCase();
  const inFocus = (result?.findings ?? []).filter((f) => f.category !== "large" && (!prefix || f.path.toLowerCase().startsWith(prefix)));
  const staleHere = inFocus.filter((f) => f.category === "global" || isStale(f.lastActive));
  const allSelected = inFocus.length > 0 && inFocus.every((f) => selected.has(f.path));

  return (
    <>
      <PageHead title="Disk map" sub="Area is size. Coloured blocks are dev junk; grey is everything else. Click a folder to zoom in." />
      <div className="map-layout">
        <div className="map-frame glass">
          <nav className="crumbs" aria-label="Map location">
            {crumbs.map((c, i) => (
              <span key={c.path || "root"} style={{ display: "inline-flex", alignItems: "center" }}>
                {i > 0 && <ChevronRight size={13} className="muted" />}
                <button aria-current={i === crumbs.length - 1} onClick={() => setTrail(trail.slice(0, i))}>
                  {c.name}
                </button>
              </span>
            ))}
            <span className="muted" style={{ marginLeft: "auto" }}>
              {bytes(focus.size)}
            </span>
          </nav>
          <div
            className="treemap"
            ref={box}
            onMouseLeave={() => setTip(null)}
            onKeyDown={(e) => {
              if ((e.key === "Backspace" || e.key === "Escape") && trail.length) setTrail(trail.slice(0, -1));
            }}
          >
            {leaves.map((d) => {
              const c = d.data;
              const w = d.x1 - d.x0;
              const h = d.y1 - d.y0;
              if (w < 2 || h < 2) return null;
              const frame = !!d.children;
              const zoomable = !!c.node && c.node.children.length > 0 && !c.category;
              const cls = c.node === null ? "rest" : frame ? "frame" : `leaf${c.category ? " cat" : ""}`;
              return (
                <div
                  key={c.key}
                  className={`tm-node ${cls}`}
                  style={{ left: d.x0, top: d.y0, width: w, height: h, background: tileBackground(c, frame) }}
                  role={zoomable ? "button" : undefined}
                  tabIndex={zoomable && d.depth === 1 ? 0 : -1}
                  aria-label={`${c.name}, ${bytes(c.size)}${c.category ? `, ${CATEGORY[c.category].label}` : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (zoomable) zoom(c.node);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && zoomable && zoom(c.node)}
                  onMouseMove={(e) => {
                    e.stopPropagation();
                    setTip({ x: e.clientX, y: e.clientY, d });
                  }}
                >
                  {w > 54 && h > 16 && (
                    <span className="tm-label">
                      {c.name}
                      {w > 110 && <small>{bytes(c.size)}</small>}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <aside className="map-side">
          <section className="card glass">
            <h3>In this folder</h3>
            <p className="sub">
              {bytes(totalJunk)} of {bytes(focus.size)} is dev junk ({((totalJunk / Math.max(1, focus.size)) * 100).toFixed(0)}%)
            </p>
            {CATEGORIES.filter((c) => c !== "large").map((c) => (
              <div key={c} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                <span className="dot" style={{ background: CATEGORY[c].color }} />
                <span style={{ flex: 1 }}>{CATEGORY[c].label}</span>
                <b className="num">{bytes(junk[c])}</b>
              </div>
            ))}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
              <span className="dot" style={{ background: "var(--c-none)" }} />
              <span style={{ flex: 1 }} className="secondary">
                Everything else
              </span>
              <b className="num secondary">{bytes(Math.max(0, focus.size - totalJunk))}</b>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
              <button className="btn sm tinted" disabled={!staleHere.length} onClick={() => setMany(staleHere.map((f) => f.path), true)}>
                Select stale · {bytes(sum(staleHere))}
              </button>
              <button className="btn sm" disabled={!inFocus.length} onClick={() => setMany(inFocus.map((f) => f.path), !allSelected)}>
                {allSelected ? "Deselect all" : `Select all · ${bytes(sum(inFocus))}`}
              </button>
            </div>
          </section>
          <section className="list glass" aria-label="Largest items here">
            {focus.children.slice(0, 12).map((c) => {
              const zoomable = c.children.length > 0 && !c.category;
              return (
                <div key={c.path} className={`row${zoomable ? " clickable" : ""}`} style={{ minHeight: 42 }} onClick={() => zoomable && zoom(c)}>
                  <span className="dot" style={{ background: c.category ? CATEGORY[c.category].color : "var(--c-none)" }} />
                  <div className="body">
                    <div className="title truncate">{c.name}</div>
                  </div>
                  <span className="num secondary">{bytes(c.size)}</span>
                </div>
              );
            })}
          </section>
          <p className="muted" style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", margin: "0 4px" }}>
            <MousePointerClick size={14} /> Click to zoom · <span className="kbd">Esc</span> goes up
          </p>
        </aside>
      </div>
      {tip && (
        <div className="tm-tip glass" style={{ left: Math.min(tip.x + 14, window.innerWidth - 370), top: tip.y + 14 }}>
          <b>{tip.d.data.name}</b>
          <div className="num">
            {bytes(tip.d.data.size)} · {((tip.d.data.size / Math.max(1, focus.size)) * 100).toFixed(1)}% of {focus.name}
          </div>
          {tip.d.data.category && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
              <span className="dot" style={{ background: CATEGORY[tip.d.data.category].color }} /> {CATEGORY[tip.d.data.category].label}
            </div>
          )}
          {tip.d.data.junk && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="dot" style={{ background: CATEGORY[tip.d.data.junk.category].color }} /> {bytes(tip.d.data.junk.size)} of dev junk inside
            </div>
          )}
          {tip.d.data.node && <div className="mono muted truncate">{tip.d.data.node.path}</div>}
        </div>
      )}
    </>
  );
}
