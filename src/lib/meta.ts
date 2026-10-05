import { Boxes, Cpu, Database, FileWarning, Hammer, type LucideIcon } from "lucide-react";
import type { Category } from "./types";

export interface CategoryMeta {
  label: string;
  short: string;
  color: string;
  icon: LucideIcon;
  hint: string;
}

/** Fixed order — colour follows the category, never its rank. */
export const CATEGORIES: Category[] = ["deps", "build", "cache", "global", "large"];

export const CATEGORY: Record<Category, CategoryMeta> = {
  deps: { label: "Dependencies", short: "Deps", color: "var(--c-deps)", icon: Boxes, hint: "node_modules, venvs, pods — reinstall to restore" },
  build: { label: "Build output", short: "Builds", color: "var(--c-build)", icon: Hammer, hint: "target/, dist/, .next, bin/obj — rebuilt on demand" },
  cache: { label: "Project caches", short: "Caches", color: "var(--c-cache)", icon: Cpu, hint: ".turbo, __pycache__, .gradle — safe to drop" },
  global: { label: "Package caches", short: "Global", color: "var(--c-global)", icon: Database, hint: "pnpm store, npm, cargo registry — re-downloaded" },
  large: { label: "Heavy files", short: "Heavy", color: "var(--c-large)", icon: FileWarning, hint: "Big files inside projects — review before deleting" },
};

export const STACK_LABEL: Record<string, string> = {
  node: "Node",
  rust: "Rust",
  tauri: "Tauri",
  python: "Python",
  go: "Go",
  java: "Java",
  kotlin: "Kotlin",
  flutter: "Flutter",
  php: "PHP",
  ruby: "Ruby",
  deno: "Deno",
  dotnet: ".NET",
  docker: "Docker",
  "c++": "C++",
};
