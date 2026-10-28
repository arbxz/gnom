//! Places gnom must leave alone.
//!
//! `protected` paths are never deleted: container engines, virtual machines and installed
//! programs keep state there that no rebuild brings back. `off_limits` adds the app and
//! system data folders, where a `node_modules` or `dist` belongs to an installed app, not to
//! a project of yours: the scanner still measures them for the map but reports nothing inside.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Virtual disk formats of Hyper-V and WSL: always attached to some VM or distro.
const VM_DISK_EXT: &[&str] = &["vhd", "vhdx", "avhdx"];

pub fn protected(path: &Path) -> bool {
    let p = norm(path);
    let name = p.rsplit('\\').next().unwrap_or("");
    if name.rsplit_once('.').is_some_and(|(_, ext)| VM_DISK_EXT.contains(&ext)) {
        return true;
    }
    // Inside a protected folder, or a folder that contains one.
    roots().protected.iter().any(|r| inside(&p, r) || inside(r, &p))
}

pub fn off_limits(path: &Path) -> bool {
    let p = norm(path);
    roots().protected.iter().chain(&roots().app_data).any(|r| inside(&p, r))
}

/// A WSL distro: Docker Desktop, Rancher Desktop and Podman machines all run as one.
pub struct Distro {
    pub name: String,
    pub base: PathBuf,
}

/// Registered WSL distros, read from the registry so imported ones in custom folders count too.
pub fn wsl_distros() -> &'static [Distro] {
    static DISTROS: OnceLock<Vec<Distro>> = OnceLock::new();
    DISTROS.get_or_init(|| {
        let Ok(out) = crate::docker::cmd("reg").args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss", "/s"]).output() else {
            return Vec::new();
        };
        let text = String::from_utf8_lossy(&out.stdout);
        let mut v = Vec::new();
        let (mut name, mut base) = (None, None);
        for line in text.lines() {
            if line.starts_with("HKEY_") {
                if let (Some(n), Some(b)) = (name.take(), base.take()) {
                    v.push(Distro { name: n, base: b });
                }
                continue;
            }
            let mut parts = line.trim().splitn(3, "    ");
            match (parts.next(), parts.next(), parts.next()) {
                (Some("DistributionName"), Some(_), Some(val)) => name = Some(val.trim().to_string()),
                (Some("BasePath"), Some(_), Some(val)) => base = Some(PathBuf::from(val.trim().trim_start_matches(r"\\?\"))),
                _ => {}
            }
        }
        if let (Some(n), Some(b)) = (name, base) {
            v.push(Distro { name: n, base: b });
        }
        v
    })
}

struct Roots {
    protected: Vec<String>,
    app_data: Vec<String>,
}

/// Looked up once: the scanner asks about every folder it visits.
fn roots() -> &'static Roots {
    static ROOTS: OnceLock<Roots> = OnceLock::new();
    ROOTS.get_or_init(|| {
        let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
        let home = dirs::home_dir();
        let local = dirs::data_local_dir();
        let roaming = dirs::data_dir();
        let program_data = env("ProgramData");
        let under = |base: &Option<PathBuf>, rels: &[&str]| -> Vec<PathBuf> {
            base.as_ref().map(|b| rels.iter().map(|r| b.join(r)).collect()).unwrap_or_default()
        };

        let mut protected: Vec<PathBuf> = Vec::new();
        // Container engines: Docker Desktop, Rancher Desktop, Podman, nerdctl, Lima/Colima, OrbStack, minikube.
        protected.extend(under(&local, &["Docker", "Docker Desktop", "rancher-desktop", "containers", "Packages", "Programs"]));
        protected.extend(under(&roaming, &["Docker", "Docker Desktop", "rancher-desktop", "containers"]));
        protected.extend(under(
            &home,
            &[".docker", ".rd", ".local/share/containers", ".config/containers", ".lima", ".colima", ".orbstack", ".minikube", ".kube", ".vagrant.d", "VirtualBox VMs", "Documents/Virtual Machines"],
        ));
        protected.extend(under(
            &program_data,
            &["Docker", "DockerDesktop", "containers", "Multipass", r"Microsoft\Windows\Hyper-V", r"Microsoft\Windows\Virtual Hard Disks"],
        ));
        protected.extend(under(&env("PUBLIC"), &[r"Documents\Hyper-V"]));
        // Installed programs and Windows itself.
        protected.extend(["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "SystemRoot"].iter().filter_map(|k| env(k)));
        protected.extend(wsl_distros().iter().map(|d| d.base.clone()));

        let mut app_data: Vec<PathBuf> = Vec::new();
        app_data.extend(local.clone());
        app_data.extend(roaming);
        app_data.extend(local.as_ref().and_then(|l| l.parent().map(|p| p.join("LocalLow"))));
        app_data.extend(program_data);

        let norm_all = |v: Vec<PathBuf>| v.iter().map(|p| norm(p)).filter(|p| !p.is_empty()).collect();
        Roots { protected: norm_all(protected), app_data: norm_all(app_data) }
    })
}

fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

fn inside(p: &str, root: &str) -> bool {
    p == root || p.strip_prefix(root).is_some_and(|rest| rest.starts_with('\\'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guards_engines_vms_and_apps() {
        let local = dirs::data_local_dir().unwrap();
        let home = dirs::home_dir().unwrap();
        for p in [
            local.join(r"Docker\wsl\disk\docker_data.vhdx"),
            local.join("Docker"),
            local.join(r"rancher-desktop\distro-data\ext4.vhdx"),
            home.join(r".local\share\containers\podman\machine\wsl\wsldist\podman-machine-default\ext4.vhdx"),
            local.join(r"Programs\Microsoft VS Code\resources\app\node_modules"),
            local.clone(),
            PathBuf::from(r"D:\wsl\Ubuntu\ext4.vhdx"),
            PathBuf::from(r"D:\vms\dev.avhdx"),
        ] {
            assert!(protected(&p), "{} should be protected", p.display());
        }
        for p in [home.join(r"code\app\node_modules"), home.join(r"code\app\target"), PathBuf::from(r"C:\code\vm-notes.vhdx.txt")] {
            assert!(!protected(&p), "{} should be deletable", p.display());
            assert!(!off_limits(&p), "{} should be scanned", p.display());
        }
        // App data is skipped by the scanner but package caches inside it stay deletable.
        assert!(off_limits(&local.join(r"Discord\app-1.0\modules\node_modules")));
        assert!(!protected(&local.join(r"pnpm\store")));
        // Ancestors of protected folders are not off limits, so projects in the home folder still count.
        assert!(!off_limits(&home));
    }
}
