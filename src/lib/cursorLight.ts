/**
 * Cursor-following glass light. On mouse move, every glass surface / button under the
 * pointer gets --mx/--my (px, relative to itself) and data-lit; CSS draws the bloom and rim.
 * One rAF-batched write per frame; skipped for touch, reduced motion and reduced transparency.
 */
const LIT = ".glass, .btn, .nav-item";

export function installCursorLight() {
  const quiet = () =>
    matchMedia("(prefers-reduced-motion: reduce)").matches ||
    matchMedia("(prefers-reduced-transparency: reduce)").matches ||
    document.documentElement.hasAttribute("data-solid");
  let lit = new Set<HTMLElement>();
  let pending: PointerEvent | null = null;

  const clear = () => {
    for (const el of lit) el.removeAttribute("data-lit");
    lit = new Set();
  };

  const frame = () => {
    const e = pending;
    pending = null;
    if (!e) return;
    const next = new Set<HTMLElement>();
    for (let n = (e.target as Element | null)?.closest<HTMLElement>(LIT); n; n = n.parentElement?.closest<HTMLElement>(LIT)) {
      const r = n.getBoundingClientRect();
      n.style.setProperty("--mx", `${e.clientX - r.left}px`);
      n.style.setProperty("--my", `${e.clientY - r.top}px`);
      if (!lit.has(n)) n.setAttribute("data-lit", "");
      next.add(n);
    }
    for (const el of lit) if (!next.has(el)) el.removeAttribute("data-lit");
    lit = next;
  };

  document.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "mouse" || quiet()) return clear();
      if (!pending) requestAnimationFrame(frame);
      pending = e;
    },
    { passive: true },
  );
  document.addEventListener("pointerleave", clear);
  window.addEventListener("blur", clear);
}
