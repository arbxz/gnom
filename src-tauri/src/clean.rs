//! Deleting things. Only paths returned by the last scan may be removed.

use crate::docker::cmd;
use std::fs;
use rayon::prelude::*;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

fn make_writable(path: &Path) {
    if let Ok(md) = fs::symlink_metadata(path) {
        let mut perm = md.permissions();
        if perm.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            perm.set_readonly(false);
            let _ = fs::set_permissions(path, perm);
        }
    }
}

/// Deletes a tree file by file so progress can be reported in bytes. Links and
/// junctions (pnpm's node_modules is full of them) are unlinked, never followed.
fn remove_tree(dir: &Path, freed: &AtomicU64) -> std::io::Result<()> {
    let mut subdirs = Vec::new();
    for e in fs::read_dir(dir)?.flatten() {
        let p = e.path();
        let ft = e.file_type()?;
        if ft.is_symlink() {
            let _ = fs::remove_dir(&p).or_else(|_| fs::remove_file(&p));
        } else if ft.is_dir() {
            subdirs.push(p);
        } else {
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            // git packs and some npm tarballs ship read-only files, which Windows refuses to unlink.
            if fs::remove_file(&p).is_err() {
                make_writable(&p);
                fs::remove_file(&p)?;
            }
            freed.fetch_add(size, Ordering::Relaxed);
        }
    }
    subdirs.par_iter().try_for_each(|d| remove_tree(d, freed))?;
    fs::remove_dir(dir).or_else(|_| {
        make_writable(dir);
        fs::remove_dir(dir)
    })
}

/// `freed` grows as bytes are deleted; Recycle Bin moves only report once at the end.
pub fn remove(path: &Path, to_trash: bool, size: u64, freed: &AtomicU64) -> Result<(), String> {
    if crate::guard::protected(path) {
        return Err("gnom never deletes container, VM or installed app data".into());
    }
    if to_trash {
        trash::delete(path).map_err(|e| e.to_string())?;
        freed.fetch_add(size, Ordering::Relaxed);
        return Ok(());
    }
    let md = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if md.is_dir() && !md.file_type().is_symlink() {
        remove_tree(path, freed)
    } else {
        fs::remove_file(path).map(|_| {
            freed.fetch_add(md.len(), Ordering::Relaxed);
        })
    }
    .map_err(|e| e.to_string())
}

pub fn run_shell(command: &str, cwd: Option<&Path>) -> Result<String, String> {
    let mut c = if cfg!(windows) {
        let mut c = cmd("cmd");
        c.args(["/C", command]);
        c
    } else {
        let mut c = cmd("sh");
        c.args(["-c", command]);
        c
    };
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    let out = c.output().map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() { Ok(text.trim().to_string()) } else { Err(text.trim().to_string()) }
}

pub fn reveal(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let r = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer").raw_arg(format!("/select,\"{}\"", path.display())).spawn()
    };
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg("-R").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(path.parent().unwrap_or(path)).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_tree_without_following_junctions() {
        let base = std::env::temp_dir().join(format!("gnom-clean-{}", std::process::id()));
        let victim = base.join("node_modules");
        let outside = base.join("store");
        fs::create_dir_all(victim.join("a/b")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(victim.join("a/b/f.txt"), vec![0u8; 1000]).unwrap();
        fs::write(outside.join("keep.txt"), b"keep").unwrap();
        let ro = victim.join("a/ro.txt");
        fs::write(&ro, vec![0u8; 24]).unwrap();
        let mut perm = fs::metadata(&ro).unwrap().permissions();
        perm.set_readonly(true);
        fs::set_permissions(&ro, perm).unwrap();
        #[cfg(windows)]
        let linked = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(victim.join("link"))
            .arg(&outside)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, victim.join("link")).is_ok();

        let freed = AtomicU64::new(0);
        remove(&victim, false, 1024, &freed).unwrap();
        assert!(!victim.exists());
        assert_eq!(freed.load(Ordering::Relaxed), 1024);
        if linked {
            assert!(outside.join("keep.txt").exists(), "junction target must survive");
        }
        fs::remove_dir_all(&base).unwrap();
    }
}
