use serde::{Deserialize, Serialize};

/// What a piece of reclaimable space is, which drives colour, grouping and the
/// wording of the "is it safe?" hint in the UI.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    /// Installed dependencies: node_modules, vendored pods, python venvs.
    Deps,
    /// Compiler output: Rust target, dist, bin/obj, .next.
    Build,
    /// Tool caches living inside a project: .turbo, __pycache__, .gradle.
    Cache,
    /// Machine-wide package caches: npm, pnpm store, cargo registry.
    Global,
    /// A single oversized file that is not part of any of the above.
    Large,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub path: String,
    pub category: Category,
    pub label: String,
    pub size: u64,
    pub files: u64,
    /// Root of the project this belongs to, if any.
    pub project: Option<String>,
    /// Unix seconds of the newest file in the owning project (or the item itself).
    pub last_active: Option<u64>,
    /// How to get it back after deleting it.
    pub regen: Option<String>,
    pub note: Option<String>,
    pub tags: Vec<String>,
    /// The largest files inside, so a 6 GB target dir explains itself.
    pub top_files: Vec<FileEntry>,
    /// For global caches: id of the official clean command, if one exists.
    pub command_id: Option<String>,
    pub command: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub path: String,
    pub name: String,
    pub stacks: Vec<String>,
    pub last_active: Option<u64>,
    pub size: u64,
    pub has_git: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub category: Option<Category>,
    pub children: Vec<Node>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub roots: Vec<String>,
    pub findings: Vec<Finding>,
    pub projects: Vec<Project>,
    pub tree: Vec<Node>,
    pub files: u64,
    pub bytes: u64,
    pub duration_ms: u64,
    pub finished_at: u64,
    pub cancelled: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanOptions {
    pub roots: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default = "default_large_mb")]
    pub large_file_mb: u64,
}

fn default_large_mb() -> u64 {
    200
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub found: u64,
    pub current: String,
    pub phase: String,
}
