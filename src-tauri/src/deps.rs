//! A quick, dependency-free "possibly unused npm packages" check: a declared package
//! counts as used if any source/config file quotes its module name, or a package.json
//! script calls one of its binaries. Deliberately conservative — it only lists suspects.

use crate::scan::{size_tree, Counters};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepReport {
    pub manager: String,
    pub scanned_files: usize,
    pub deps: Vec<Dep>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dep {
    pub name: String,
    pub dev: bool,
    pub used: bool,
    pub size: u64,
}

const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".output", ".svelte-kit", "target", "coverage", ".turbo", ".vercel",
];
const EXTS: &[&str] = &[
    "js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "astro", "json", "yml", "yaml", "html", "css", "scss", "less", "md", "mdx",
];
const MAX_FILES: usize = 6000;
const MAX_BYTES: u64 = 1 << 20;

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    if out.len() >= MAX_FILES {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        let name = e.file_name().to_string_lossy().to_ascii_lowercase();
        if ft.is_dir() && !ft.is_symlink() {
            if !SKIP_DIRS.contains(&name.as_str()) {
                collect(&e.path(), out);
            }
        } else if ft.is_file() && name != "package.json" && !name.ends_with("lock.json") && !name.ends_with(".lock") && name != "pnpm-lock.yaml" {
            // dotfiles like .eslintrc / .babelrc have no extension but often name plugins
            let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
            if EXTS.contains(&ext) || name.starts_with('.') {
                out.push(e.path());
            }
        }
    }
}

fn bins(project: &Path, name: &str) -> Vec<String> {
    let pkg = project.join("node_modules").join(name).join("package.json");
    let Ok(text) = fs::read_to_string(pkg) else { return vec![name.rsplit('/').next().unwrap_or(name).to_string()] };
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    match v.get("bin") {
        Some(Value::Object(m)) => m.keys().cloned().collect(),
        Some(Value::String(_)) => vec![name.rsplit('/').next().unwrap_or(name).to_string()],
        _ => vec![],
    }
}

pub fn check(project: &Path) -> Result<DepReport, String> {
    let text = fs::read_to_string(project.join("package.json")).map_err(|e| format!("No package.json: {e}"))?;
    let pkg: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut declared: Vec<(String, bool)> = Vec::new();
    for (key, dev) in [("dependencies", false), ("devDependencies", true)] {
        if let Some(Value::Object(m)) = pkg.get(key) {
            declared.extend(m.keys().map(|k| (k.clone(), dev)));
        }
    }
    let scripts: String = match pkg.get("scripts") {
        Some(Value::Object(m)) => m.values().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(" \n "),
        _ => String::new(),
    };

    let mut files = Vec::new();
    collect(project, &mut files);
    let mut corpus = String::new();
    for f in &files {
        if fs::metadata(f).map(|m| m.len() <= MAX_BYTES).unwrap_or(false) {
            if let Ok(t) = fs::read_to_string(f) {
                corpus.push_str(&t);
                corpus.push('\n');
            }
        }
    }

    let quoted = |m: &str| {
        ['"', '\'', '`'].iter().any(|q| corpus.contains(&format!("{q}{m}{q}")) || corpus.contains(&format!("{q}{m}/")))
    };
    let in_scripts = |bin: &str| scripts.split(|c: char| c.is_whitespace() || c == '&' || c == '|' || c == ';' || c == '(').any(|t| t == bin);

    let counters = Counters::default();
    let names: Vec<String> = declared.iter().map(|(n, _)| n.clone()).collect();
    let deps = declared
        .into_iter()
        .map(|(name, dev)| {
            let used = if let Some(base) = name.strip_prefix("@types/") {
                // @types/foo is used if foo is; scoped @types/scope__pkg maps back to @scope/pkg.
                let base = base.replace("__", "/");
                let base = if name.contains("__") { format!("@{base}") } else { base };
                base == "node" || names.contains(&base) || quoted(&base)
            } else {
                quoted(&name) || bins(project, &name).iter().any(|b| in_scripts(b)) || in_scripts(&name)
            };
            let dir = project.join("node_modules").join(&name);
            let real = fs::canonicalize(&dir).unwrap_or(dir);
            Dep { size: size_tree(&real, &counters).size, name, dev, used }
        })
        .collect();

    let manager = if project.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if project.join("yarn.lock").exists() {
        "yarn"
    } else if project.join("bun.lockb").exists() || project.join("bun.lock").exists() {
        "bun"
    } else {
        "npm"
    };
    Ok(DepReport { manager: manager.into(), scanned_files: files.len(), deps })
}
