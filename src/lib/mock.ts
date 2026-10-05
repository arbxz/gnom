// Demo data for running the UI in a plain browser (no Tauri backend).
import type { Category, DepReport, DockerReport, Finding, Project, ScanProgress, ScanResult, TreeNode } from "./types";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const HOME = "C:\\Users\\dev";
const now = Math.floor(Date.now() / 1000);
const daysAgo = (d: number) => now - d * 86400;

interface MockArtifact {
  rel: string;
  label: string;
  category: Category;
  size: number;
  regen?: string;
  tags?: string[];
  note?: string;
}
interface MockProject {
  dir: string;
  stacks: string[];
  age: number;
  src: number;
  artifacts: MockArtifact[];
}

const nm = (size: number): MockArtifact => ({ rel: "node_modules", label: "node_modules", category: "deps", size, regen: "pnpm install" });

const PROJECTS: MockProject[] = [
  {
    dir: "code\\tauri-notes",
    stacks: ["node", "tauri"],
    age: 74,
    src: 40 * MB,
    artifacts: [
      { rel: "src-tauri\\target", label: "Tauri target", category: "build", size: 9.4 * GB, regen: "cargo build", tags: ["rust", "tauri"], note: "Tauri builds keep debug + release WebView2 bundles and incremental caches; multi-GB is normal." },
      nm(612 * MB),
      { rel: "dist", label: "JS build output", category: "build", size: 18 * MB, regen: "npm run build" },
    ],
  },
  {
    dir: "code\\pixel-forge",
    stacks: ["node", "tauri"],
    age: 3,
    src: 120 * MB,
    artifacts: [
      { rel: "src-tauri\\target", label: "Tauri target", category: "build", size: 6.1 * GB, regen: "cargo build", tags: ["rust", "tauri"] },
      nm(780 * MB),
      { rel: "assets\\raw\\intro-capture.mov", label: "Media", category: "large", size: 2.3 * GB },
    ],
  },
  {
    dir: "code\\shop-monorepo",
    stacks: ["node", "docker"],
    age: 1,
    src: 210 * MB,
    artifacts: [nm(2.8 * GB), { rel: "apps\\web\\.next", label: ".next", category: "build", size: 1.1 * GB, regen: "next build" }, { rel: ".turbo", label: ".turbo", category: "cache", size: 640 * MB, regen: "turbo run" }],
  },
  { dir: "code\\old-portfolio", stacks: ["node"], age: 410, src: 12 * MB, artifacts: [nm(540 * MB), { rel: ".next", label: ".next", category: "build", size: 380 * MB, regen: "next build" }] },
  {
    dir: "code\\rust-raytracer",
    stacks: ["rust"],
    age: 120,
    src: 6 * MB,
    artifacts: [{ rel: "target", label: "Rust target", category: "build", size: 3.6 * GB, regen: "cargo build", tags: ["rust"] }, { rel: "renders\\frames.zip", label: "Archive", category: "large", size: 880 * MB }],
  },
  {
    dir: "code\\ml-sandbox",
    stacks: ["python"],
    age: 200,
    src: 30 * MB,
    artifacts: [
      { rel: ".venv", label: "Python venv", category: "deps", size: 4.2 * GB, regen: "python -m venv && pip install -r requirements.txt" },
      { rel: "models\\llama-3b.gguf", label: "Model weights / blob", category: "large", size: 1.9 * GB },
      { rel: "__pycache__", label: "__pycache__", category: "cache", size: 4 * MB },
    ],
  },
  { dir: "code\\api-gateway", stacks: ["go", "docker"], age: 9, src: 20 * MB, artifacts: [{ rel: "build", label: "Build output", category: "build", size: 240 * MB }] },
  { dir: "code\\flutter-habit", stacks: ["flutter"], age: 160, src: 25 * MB, artifacts: [{ rel: "build", label: "Build output", category: "build", size: 1.4 * GB, regen: "flutter build" }, { rel: ".dart_tool", label: ".dart_tool", category: "cache", size: 310 * MB, regen: "flutter pub get" }] },
  { dir: "code\\dotnet-invoices", stacks: ["dotnet"], age: 95, src: 8 * MB, artifacts: [{ rel: "bin", label: ".NET bin/obj", category: "build", size: 420 * MB, regen: "dotnet build" }, { rel: "obj", label: ".NET bin/obj", category: "build", size: 160 * MB, regen: "dotnet build" }] },
  { dir: "Desktop\\hackathon-2024", stacks: ["node"], age: 520, src: 4 * MB, artifacts: [nm(910 * MB), { rel: "logs\\debug.log", label: "Log", category: "large", size: 640 * MB }] },
];

const GLOBALS: (MockArtifact & { id: string; command?: string })[] = [
  { id: "pnpm", rel: "AppData\\Local\\pnpm\\store", label: "pnpm store", category: "global", size: 7.8 * GB, command: "pnpm store prune", note: "Prune keeps packages still linked by a project; deleting the folder forces full re-downloads." },
  { id: "cargo-registry", rel: ".cargo\\registry", label: "Cargo registry", category: "global", size: 2.6 * GB },
  { id: "npm", rel: "AppData\\Local\\npm-cache", label: "npm cache", category: "global", size: 1.7 * GB, command: "npm cache clean --force" },
  { id: "playwright", rel: "AppData\\Local\\ms-playwright", label: "Playwright browsers", category: "global", size: 1.2 * GB, note: "Re-download with `npx playwright install`." },
  { id: "pip", rel: "AppData\\Local\\pip\\Cache", label: "pip cache", category: "global", size: 920 * MB, command: "pip cache purge" },
  { id: "gradle", rel: ".gradle\\caches", label: "Gradle caches", category: "global", size: 2.1 * GB },
  { id: "yarn", rel: "AppData\\Local\\Yarn\\Cache", label: "Yarn cache", category: "global", size: 450 * MB, command: "yarn cache clean" },
];

function topFiles(path: string, size: number, a: MockArtifact) {
  if (a.category !== "build" || !a.tags?.includes("rust")) return [];
  return [
    { path: `${path}\\debug\\deps\\app_lib.pdb`, size: size * 0.11 },
    { path: `${path}\\release\\app.exe`, size: size * 0.03 },
    { path: `${path}\\debug\\incremental\\app_lib-1x2y\\s-h0.bin`, size: size * 0.02 },
  ].map((f) => ({ ...f, size: Math.round(f.size) }));
}

function insert(root: TreeNode, rel: string, size: number, category: Category | null) {
  const parts = rel.split("\\");
  let node = root;
  let path = root.path;
  parts.forEach((part, i) => {
    path = `${path}\\${part}`;
    node.size += size;
    let child = node.children.find((c) => c.name === part);
    if (!child) {
      child = { name: part, path, size: 0, category: null, children: [] };
      node.children.push(child);
    }
    if (i === parts.length - 1) {
      child.size += size;
      child.category = category;
    }
    node = child;
  });
}

function sortTree(n: TreeNode) {
  n.children.sort((a, b) => b.size - a.size);
  n.children.forEach(sortTree);
}

function build(): ScanResult {
  const root: TreeNode = { name: "dev", path: HOME, size: 0, category: null, children: [] };
  const findings: Finding[] = [];
  const projects: Project[] = [];
  for (const p of PROJECTS) {
    const projPath = `${HOME}\\${p.dir}`;
    insert(root, `${p.dir}\\src`, p.src, null);
    let size = p.src;
    for (const a of p.artifacts) {
      const path = `${projPath}\\${a.rel}`;
      insert(root, `${p.dir}\\${a.rel}`, a.size, a.category === "large" ? null : a.category);
      size += a.size;
      findings.push({
        path,
        category: a.category,
        label: a.label,
        size: Math.round(a.size),
        files: a.category === "large" ? 1 : Math.round(a.size / (40 * 1024)),
        project: projPath,
        lastActive: daysAgo(p.age),
        regen: a.regen ?? null,
        note: a.note ?? null,
        tags: a.tags ?? [],
        topFiles: topFiles(path, a.size, a),
        commandId: null,
        command: null,
      });
    }
    projects.push({ path: projPath, name: p.dir.split("\\").pop()!, stacks: p.stacks, lastActive: daysAgo(p.age), size: Math.round(size), hasGit: true });
  }
  for (const g of GLOBALS) {
    insert(root, g.rel, g.size, "global");
    findings.push({
      path: `${HOME}\\${g.rel}`,
      category: "global",
      label: g.label,
      size: Math.round(g.size),
      files: Math.round(g.size / (60 * 1024)),
      project: null,
      lastActive: daysAgo(4),
      regen: "Re-downloaded on demand by its tool",
      note: g.note ?? null,
      tags: [g.id],
      topFiles: [],
      commandId: g.command ? g.id : null,
      command: g.command ?? null,
    });
  }
  insert(root, "Videos\\Screen Recordings", 14 * GB, null);
  insert(root, "Downloads", 9.2 * GB, null);
  insert(root, "AppData\\Local\\Google\\Chrome", 3.1 * GB, null);
  insert(root, "AppData\\Roaming\\Code", 1.6 * GB, null);
  insert(root, "Documents", 5.4 * GB, null);
  insert(root, "OneDrive\\Pictures", 7.2 * GB, null);
  sortTree(root);
  findings.sort((a, b) => b.size - a.size);
  const files = 1_284_311;
  return { roots: [HOME], findings, projects, tree: [root], files, bytes: root.size, durationMs: 23_400, finishedAt: now, cancelled: false };
}

let cancelled = false;
export function cancelMock() {
  cancelled = true;
}

export async function mockScan(onProgress: (p: ScanProgress) => void): Promise<ScanResult> {
  cancelled = false;
  const result = build();
  const steps = 26;
  const paths = result.findings.map((f) => f.path);
  for (let i = 1; i <= steps && !cancelled; i++) {
    await new Promise((r) => setTimeout(r, 80));
    onProgress({
      files: Math.round((result.files * i) / steps),
      dirs: Math.round((140_000 * i) / steps),
      bytes: Math.round((result.bytes * i) / steps),
      found: Math.round((result.findings.length * i) / steps),
      current: paths[i % paths.length],
      phase: i < 5 ? "Measuring package caches" : "Walking projects",
    });
  }
  return { ...result, cancelled };
}

export async function mockDocker(): Promise<DockerReport> {
  await new Promise((r) => setTimeout(r, 400));
  const img = (repo: string, tag: string, size: number, since: string, inUse: boolean) => ({
    id: `sha256:${Math.random().toString(16).slice(2).padEnd(64, "0")}`,
    repo,
    tag,
    size,
    createdAt: "",
    createdSince: since,
    dangling: repo === "<none>",
    inUse,
  });
  return {
    installed: true,
    running: true,
    error: null,
    version: "29.8.0",
    images: [
      img("pytorch/pytorch", "2.4.0-cuda12.1", 9.6e9, "11 months ago", false),
      img("shop-monorepo-web", "latest", 1.4e9, "2 days ago", true),
      img("postgres", "16", 4.5e8, "3 weeks ago", true),
      img("<none>", "<none>", 1.3e9, "5 weeks ago", false),
      img("<none>", "<none>", 1.2e9, "7 weeks ago", false),
      img("node", "18-bullseye", 1.1e9, "14 months ago", false),
      img("redis", "7-alpine", 4.1e7, "2 months ago", true),
    ],
    containers: [
      { id: "a1", name: "shop-web-1", image: "shop-monorepo-web", state: "running", status: "Up 3 hours" },
      { id: "b2", name: "shop-db-1", image: "postgres:16", state: "running", status: "Up 3 hours" },
      { id: "c3", name: "redis", image: "redis:7-alpine", state: "exited", status: "Exited (0) 2 weeks ago" },
    ],
    df: [
      { kind: "Images", total: 7, active: 3, size: 15.1e9, reclaimable: 13.2e9 },
      { kind: "Containers", total: 3, active: 2, size: 1.2e8, reclaimable: 4e6 },
      { kind: "Local Volumes", total: 6, active: 2, size: 2.3e9, reclaimable: 1.6e9 },
      { kind: "Build Cache", total: 84, active: 0, size: 4.7e9, reclaimable: 4.7e9 },
    ],
    disks: [{ label: "Docker Desktop data", path: `${HOME}\\AppData\\Local\\Docker\\wsl\\disk\\docker_data.vhdx`, size: 38 * GB }],
  };
}

export async function mockDeps(): Promise<DepReport> {
  await new Promise((r) => setTimeout(r, 500));
  return {
    manager: "pnpm",
    scannedFiles: 214,
    deps: [
      { name: "react", dev: false, used: true, size: 312 * 1024 },
      { name: "moment", dev: false, used: false, size: 4.3 * MB },
      { name: "lodash", dev: false, used: false, size: 1.4 * MB },
      { name: "three", dev: false, used: true, size: 31 * MB },
      { name: "puppeteer", dev: true, used: false, size: 18 * MB },
      { name: "typescript", dev: true, used: true, size: 22 * MB },
      { name: "@types/lodash", dev: true, used: true, size: 2 * MB },
    ],
  };
}
