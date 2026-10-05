//! Deleting things. Only paths returned by the last scan may be removed.

use crate::docker::cmd;
use std::fs;
use std::path::Path;

fn clear_readonly(path: &Path) {
    let Ok(rd) = fs::read_dir(path) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if let Ok(md) = fs::symlink_metadata(&p) {
            let mut perm = md.permissions();
            if perm.readonly() {
                #[allow(clippy::permissions_set_readonly_false)]
                perm.set_readonly(false);
                let _ = fs::set_permissions(&p, perm);
            }
            if md.is_dir() {
                clear_readonly(&p);
            }
        }
    }
}

pub fn remove(path: &Path, to_trash: bool) -> Result<(), String> {
    if to_trash {
        return trash::delete(path).map_err(|e| e.to_string());
    }
    let md = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if md.is_dir() {
        // git packs and some npm tarballs ship read-only files, which Windows refuses to unlink.
        fs::remove_dir_all(path).or_else(|_| {
            clear_readonly(path);
            fs::remove_dir_all(path)
        })
    } else {
        fs::remove_file(path)
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
