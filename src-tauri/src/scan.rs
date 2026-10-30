//! Parallel filesystem walk that finds projects, regenerable artifacts, heavy files
//! and builds a pruned size tree for the disk map — in a single pass.

use crate::model::*;
use crate::rules::{self, Siblings};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Live counters the UI polls for the progress bar; shared with the emitter thread.
#[derive(Default)]
pub struct Counters {
    pub files: AtomicU64,
    pub dirs: AtomicU64,
    pub bytes: AtomicU64,
    pub found: AtomicU64,
    pub current: Mutex<String>,
    pub phase: Mutex<String>,
    pub cancel: AtomicBool,
}

impl Counters {
    pub fn reset(&self) {
        for c in [&self.files, &self.dirs, &self.bytes, &self.found] {
            c.store(0, Relaxed);
        }
        self.cancel.store(false, Relaxed);
        self.current.lock().unwrap().clear();
    }
    pub fn snapshot(&self) -> Progress {
        Progress {
            files: self.files.load(Relaxed),
            dirs: self.dirs.load(Relaxed),
            bytes: self.bytes.load(Relaxed),
            found: self.found.load(Relaxed),
            current: self.current.lock().unwrap().clone(),
            phase: self.phase.lock().unwrap().clone(),
        }
    }
    fn set_phase(&self, p: &str) {
        *self.phase.lock().unwrap() = p.to_string();
    }
}

/// Folders smaller than this are folded into their parent in the disk map.
const KEEP_MIN: u64 = 4 << 20;
const MAX_DEPTH: usize = 14;
const MAX_CHILDREN: usize = 48;

struct Ctx<'a> {
    c: &'a Counters,
    findings: Mutex<Vec<Finding>>,
    projects: Mutex<Vec<Project>>,
    globals: HashMap<String, u64>,
    exclude: HashSet<String>,
    large: u64,
}

struct Walked {
    node: Node,
    max_mtime: u64,
}

pub fn key(p: &Path) -> String {
    let s = p.to_string_lossy();
    if cfg!(windows) { s.to_lowercase() } else { s.into_owned() }
}

fn mtime(md: &fs::Metadata) -> u64 {
    md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
}

/// Bytes a file really takes. Sparse VM disks claim far more than they use: OrbStack's and
/// Docker Desktop's report nearly 1 TB whatever they hold.
pub fn disk_size(md: &fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        md.len().min(md.blocks() * 512)
    }
    #[cfg(not(unix))]
    {
        md.len()
    }
}

/// The volume a folder lives on, where the platform says.
fn device(md: &fs::Metadata) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(md.dev())
    }
    #[cfg(not(unix))]
    {
        let _ = md;
        None
    }
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub struct Agg {
    pub size: u64,
    pub files: u64,
    pub max_mtime: u64,
    pub top: Vec<FileEntry>,
}

const TOP_N: usize = 4;

fn push_top(top: &mut Vec<FileEntry>, e: FileEntry) {
    if top.len() < TOP_N || e.size > top.last().map(|t| t.size).unwrap_or(0) {
        top.push(e);
        top.sort_by(|a, b| b.size.cmp(&a.size));
        top.truncate(TOP_N);
    }
}

/// Sums a folder without classifying anything inside it. Never follows links.
pub fn size_tree(path: &Path, c: &Counters) -> Agg {
    let mut agg = Agg { size: 0, files: 0, max_mtime: 0, top: Vec::new() };
    if c.cancel.load(Relaxed) {
        return agg;
    }
    let Ok(rd) = fs::read_dir(path) else { return agg };
    let mut subdirs = Vec::new();
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            subdirs.push(e.path());
        } else if let Ok(md) = e.metadata() {
            let s = disk_size(&md);
            agg.size += s;
            agg.files += 1;
            agg.max_mtime = agg.max_mtime.max(mtime(&md));
            push_top(&mut agg.top, FileEntry { path: e.path().to_string_lossy().into_owned(), size: s });
        }
    }
    c.files.fetch_add(agg.files, Relaxed);
    c.bytes.fetch_add(agg.size, Relaxed);
    c.dirs.fetch_add(1, Relaxed);
    let subs: Vec<Agg> = subdirs.par_iter().map(|p| size_tree(p, c)).collect();
    for s in subs {
        agg.size += s.size;
        agg.files += s.files;
        agg.max_mtime = agg.max_mtime.max(s.max_mtime);
        for t in s.top {
            push_top(&mut agg.top, t);
        }
    }
    agg
}

fn leaf(name: &str, path: &Path, size: u64, category: Option<Category>) -> Node {
    Node { name: name.to_string(), path: path.to_string_lossy().into_owned(), size, category, children: vec![] }
}

fn walk(path: &Path, depth: usize, ctx: &Ctx, project: Option<&str>) -> Walked {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned());
    let empty = |name: String| Walked { node: leaf(&name, path, 0, None), max_mtime: 0 };
    if ctx.c.cancel.load(Relaxed) {
        return empty(name);
    }
    if ctx.c.dirs.fetch_add(1, Relaxed) % 97 == 0 {
        *ctx.c.current.lock().unwrap() = path.to_string_lossy().into_owned();
    }
    let Ok(rd) = fs::read_dir(path) else { return empty(name) };

    let mut names = HashSet::new();
    let mut subdirs: Vec<(PathBuf, String)> = Vec::new();
    let mut own_size = 0u64;
    let mut own_files = 0u64;
    let mut max_mtime = 0u64;
    let mut heavy: Vec<(PathBuf, u64, u64)> = Vec::new();
    for e in rd.flatten() {
        let fname = e.file_name().to_string_lossy().into_owned();
        names.insert(fname.to_ascii_lowercase());
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            subdirs.push((e.path(), fname));
        } else if let Ok(md) = e.metadata() {
            let s = disk_size(&md);
            own_size += s;
            own_files += 1;
            let m = mtime(&md);
            max_mtime = max_mtime.max(m);
            if s >= ctx.large {
                heavy.push((e.path(), s, m));
            }
        }
    }
    ctx.c.files.fetch_add(own_files, Relaxed);
    ctx.c.bytes.fetch_add(own_size, Relaxed);

    let has_git = names.contains(".git");
    let manifest = rules::MANIFESTS.iter().any(|(m, _)| names.contains(*m))
        || names.iter().any(|n| n.ends_with(".csproj") || n.ends_with(".sln"));
    // Apps and engines ship package.json files and .git folders too; they are not your projects.
    let off = crate::guard::off_limits(path);
    let starts_project = !off && (has_git || (project.is_none() && manifest));
    let path_str = path.to_string_lossy().into_owned();
    let proj: Option<&str> = if starts_project { Some(&path_str) } else { project };

    if let Some(p) = proj {
        for (fp, size, m) in heavy.into_iter().filter(|(fp, ..)| !off && !crate::guard::protected(fp)) {
            let fname = fp.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            ctx.c.found.fetch_add(1, Relaxed);
            ctx.findings.lock().unwrap().push(Finding {
                path: fp.to_string_lossy().into_owned(),
                category: Category::Large,
                label: rules::large_file_reason(&fname).to_string(),
                size,
                files: 1,
                project: Some(p.to_string()),
                last_active: Some(m),
                regen: None,
                note: None,
                tags: vec![],
                top_files: vec![],
                command_id: None,
                command: None,
            });
        }
    }

    let sib = Siblings { names: &names };
    let here = fs::metadata(path).ok().as_ref().and_then(device);
    let children: Vec<Option<Walked>> = subdirs
        .par_iter()
        .map(|(p, n)| {
            let k = key(p);
            if ctx.exclude.contains(&k) {
                return None;
            }
            // A mount is another disk or a view of one (~/OrbStack, network shares): add it as
            // a root to scan it. On macOS this also means a scan of / stays off the data volume.
            if here.is_some() && fs::symlink_metadata(p).ok().as_ref().and_then(device) != here {
                return None;
            }
            if let Some(&size) = ctx.globals.get(&k) {
                return Some(Walked { node: leaf(n, p, size, Some(Category::Global)), max_mtime: 0 });
            }
            let lower = n.to_ascii_lowercase();
            let rule = if crate::guard::off_limits(p) {
                None
            } else {
                rules::classify(n, &name, &sib).or_else(|| {
                    (lower.contains("env") && p.join("pyvenv.cfg").is_file()).then(rules::venv_rule)
                })
            };
            if let Some(r) = rule {
                let agg = size_tree(p, ctx.c);
                if agg.size > 0 {
                    ctx.c.found.fetch_add(1, Relaxed);
                    ctx.findings.lock().unwrap().push(Finding {
                        path: p.to_string_lossy().into_owned(),
                        category: r.category,
                        label: r.label.to_string(),
                        size: agg.size,
                        files: agg.files,
                        project: proj.map(str::to_string),
                        last_active: Some(agg.max_mtime),
                        regen: r.regen.map(str::to_string),
                        note: r.note.map(str::to_string),
                        tags: r.tags.iter().map(|t| t.to_string()).collect(),
                        top_files: agg.top,
                        command_id: None,
                        command: None,
                    });
                }
                // Artifacts never count as project activity: an install bumps their mtimes.
                return Some(Walked { node: leaf(n, p, agg.size, Some(r.category)), max_mtime: 0 });
            }
            let w = walk(p, depth + 1, ctx, proj);
            // `git fetch` touches .git constantly; it says nothing about whether you work on the code.
            Some(if lower == ".git" { Walked { max_mtime: 0, ..w } } else { w })
        })
        .collect();

    let mut size = own_size;
    let mut kids = Vec::new();
    for w in children.into_iter().flatten() {
        size += w.node.size;
        max_mtime = max_mtime.max(w.max_mtime);
        kids.push(w.node);
    }
    kids.retain(|k| k.size >= KEEP_MIN);
    kids.sort_by(|a, b| b.size.cmp(&a.size));
    kids.truncate(MAX_CHILDREN);
    if depth >= MAX_DEPTH {
        kids.clear();
    }

    if starts_project {
        let mut stacks: Vec<String> = Vec::new();
        for (m, s) in rules::MANIFESTS {
            if names.contains(*m) && !stacks.iter().any(|x| x == s) {
                stacks.push(s.to_string());
            }
        }
        if names.iter().any(|n| n.ends_with(".csproj") || n.ends_with(".sln")) {
            stacks.push("dotnet".into());
        }
        if names.contains("src-tauri") {
            stacks.push("tauri".into());
        }
        if names.contains("dockerfile") || names.contains("docker-compose.yml") || names.contains("compose.yaml") {
            stacks.push("docker".into());
        }
        ctx.projects.lock().unwrap().push(Project {
            path: path_str.clone(),
            name: name.clone(),
            stacks,
            last_active: (max_mtime > 0).then_some(max_mtime),
            size,
            has_git,
        });
    }

    Walked { node: Node { name, path: path_str, size, category: None, children: kids }, max_mtime }
}

pub fn global_findings(c: &Counters) -> Vec<Finding> {
    rules::global_caches()
        .par_iter()
        .filter_map(|g| {
            let agg = size_tree(&g.path, c);
            (agg.size > 0).then(|| Finding {
                path: g.path.to_string_lossy().into_owned(),
                category: Category::Global,
                label: g.label.to_string(),
                size: agg.size,
                files: agg.files,
                project: None,
                last_active: (agg.max_mtime > 0).then_some(agg.max_mtime),
                regen: Some("Re-downloaded on demand by its tool".into()),
                note: g.note.map(str::to_string),
                tags: vec![g.id.to_string()],
                top_files: agg.top,
                command_id: g.command.map(|_| g.id.to_string()),
                command: g.command.map(str::to_string),
            })
        })
        .collect()
}

pub fn run(opts: &ScanOptions, c: &Counters) -> ScanResult {
    let started = Instant::now();
    c.set_phase("Measuring package caches");
    let mut globals_found = global_findings(c);
    c.found.fetch_add(globals_found.len() as u64, Relaxed);

    let ctx = Ctx {
        c,
        findings: Mutex::new(Vec::new()),
        projects: Mutex::new(Vec::new()),
        globals: globals_found.iter().map(|f| (key(Path::new(&f.path)), f.size)).collect(),
        exclude: opts.exclude.iter().map(|e| key(Path::new(e))).collect(),
        large: opts.large_file_mb.max(1) * 1024 * 1024,
    };

    c.set_phase("Walking projects");
    let tree: Vec<Node> = opts
        .roots
        .iter()
        .map(|r| PathBuf::from(r))
        .filter(|r| r.is_dir())
        .map(|r| walk(&r, 0, &ctx, None).node)
        .collect();

    c.set_phase("Summarising");
    let projects = ctx.projects.into_inner().unwrap();
    let activity: HashMap<&str, Option<u64>> = projects.iter().map(|p| (p.path.as_str(), p.last_active)).collect();
    let mut findings = ctx.findings.into_inner().unwrap();
    for f in findings.iter_mut() {
        if f.category != Category::Large {
            if let Some(Some(Some(t))) = f.project.as_deref().map(|p| activity.get(p).copied()) {
                f.last_active = Some(t);
            }
        }
    }
    findings.append(&mut globals_found);
    findings.sort_by(|a, b| b.size.cmp(&a.size));

    ScanResult {
        roots: opts.roots.clone(),
        files: c.files.load(Relaxed),
        bytes: c.bytes.load(Relaxed),
        findings,
        projects,
        tree,
        duration_ms: started.elapsed().as_millis() as u64,
        finished_at: now(),
        cancelled: c.cancel.load(Relaxed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn sparse_files_count_what_they_use() {
        let p = std::env::temp_dir().join(format!("gnom-sparse-{}", std::process::id()));
        let f = fs::File::create(&p).unwrap();
        f.set_len(1 << 32).unwrap();
        let md = fs::metadata(&p).unwrap();
        assert_eq!(md.len(), 1 << 32);
        assert!(disk_size(&md) < 1 << 20);
        fs::remove_file(&p).unwrap();
        let small = std::env::temp_dir().join(format!("gnom-small-{}", std::process::id()));
        fs::write(&small, b"hello").unwrap();
        assert_eq!(disk_size(&fs::metadata(&small).unwrap()), 5);
        fs::remove_file(&small).unwrap();
    }

    /// `GNOM_ROOT=C:\code cargo test --lib real_scan -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_scan() {
        let root = std::env::var("GNOM_ROOT").expect("set GNOM_ROOT");
        let c = Counters::default();
        let r = run(&ScanOptions { roots: vec![root], exclude: vec![], large_file_mb: 100 }, &c);
        println!("{} files, {} MB in {} ms, {} projects", r.files, r.bytes >> 20, r.duration_ms, r.projects.len());
        for f in r.findings.iter().take(25) {
            println!("{:>8} MB  {:?} {:<16} {} {:?}", f.size >> 20, f.category, f.label, f.path, f.tags);
        }
        // GNOM_OUT=path saves the whole result, in the format of the app's last-scan.json.
        if let Ok(out) = std::env::var("GNOM_OUT") {
            std::fs::write(out, serde_json::to_string(&r).unwrap()).unwrap();
        }
    }
}
