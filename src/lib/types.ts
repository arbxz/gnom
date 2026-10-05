export type Category = "deps" | "build" | "cache" | "global" | "large";

export interface FileEntry {
  path: string;
  size: number;
}

export interface Finding {
  path: string;
  category: Category;
  label: string;
  size: number;
  files: number;
  project: string | null;
  lastActive: number | null;
  regen: string | null;
  note: string | null;
  tags: string[];
  topFiles: FileEntry[];
  commandId: string | null;
  command: string | null;
}

export interface Project {
  path: string;
  name: string;
  stacks: string[];
  lastActive: number | null;
  size: number;
  hasGit: boolean;
}

export interface TreeNode {
  name: string;
  path: string;
  size: number;
  category: Category | null;
  children: TreeNode[];
}

export interface ScanResult {
  roots: string[];
  findings: Finding[];
  projects: Project[];
  tree: TreeNode[];
  files: number;
  bytes: number;
  durationMs: number;
  finishedAt: number;
  cancelled: boolean;
}

export interface ScanProgress {
  files: number;
  dirs: number;
  bytes: number;
  found: number;
  current: string;
  phase: string;
}

export interface ScanOptions {
  roots: string[];
  exclude: string[];
  largeFileMb: number;
}

export interface CleanOutcome {
  path: string;
  ok: boolean;
  error: string | null;
}

export interface DockerImage {
  id: string;
  repo: string;
  tag: string;
  size: number;
  createdAt: string;
  createdSince: string;
  dangling: boolean;
  inUse: boolean;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

export interface DfRow {
  kind: string;
  total: number;
  active: number;
  size: number;
  reclaimable: number;
}

export interface VirtualDisk {
  label: string;
  path: string;
  size: number;
}

export interface DockerReport {
  installed: boolean;
  running: boolean;
  error: string | null;
  version: string | null;
  images: DockerImage[];
  containers: DockerContainer[];
  df: DfRow[];
  disks: VirtualDisk[];
}

export type DockerActionKind = "removeImages" | "pruneDangling" | "pruneContainers" | "pruneBuildCache" | "pruneVolumes";

export interface Dep {
  name: string;
  dev: boolean;
  used: boolean;
  size: number;
}

export interface DepReport {
  manager: string;
  scannedFiles: number;
  deps: Dep[];
}

export interface CleanProgress {
  freed: number;
  total: number;
  index: number;
  count: number;
  current: string;
}
