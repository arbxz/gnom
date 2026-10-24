//! Docker images, containers and caches via the docker CLI (no daemon socket access needed).

use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DockerImage {
    pub id: String,
    pub repo: String,
    pub tag: String,
    pub size: u64,
    pub created_at: String,
    pub created_since: String,
    pub dangling: bool,
    pub in_use: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub running_for: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DockerVolume {
    pub name: String,
    pub driver: String,
    /// 0 when Docker doesn't report sizes.
    pub size: u64,
    /// Referenced by at least one container, running or stopped.
    pub in_use: bool,
    /// No name was given (a 64-hex id): usually created by an image's VOLUME line.
    pub anonymous: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DfRow {
    pub kind: String,
    pub total: u64,
    pub active: u64,
    pub size: u64,
    pub reclaimable: u64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VirtualDisk {
    pub label: String,
    pub path: String,
    pub size: u64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DockerReport {
    pub installed: bool,
    pub running: bool,
    pub error: Option<String>,
    pub version: Option<String>,
    pub images: Vec<DockerImage>,
    pub containers: Vec<DockerContainer>,
    pub volumes: Vec<DockerVolume>,
    pub df: Vec<DfRow>,
    pub disks: Vec<VirtualDisk>,
}

pub fn cmd(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

fn docker(args: &[&str]) -> Result<String, String> {
    let out = cmd("docker").args(args).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn json_lines(s: &str) -> Vec<Value> {
    s.lines().filter_map(|l| serde_json::from_str(l.trim()).ok()).collect()
}

fn field(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string()
}

/// Docker prints decimal units ("1.2GB", "512kB", "0B"); a trailing "(50%)" is ignored.
pub fn parse_size(s: &str) -> u64 {
    let s = s.split_whitespace().next().unwrap_or("");
    let idx = s.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(s.len());
    let (num, unit) = s.split_at(idx);
    let n: f64 = num.parse().unwrap_or(0.0);
    let mult = match unit.to_ascii_lowercase().as_str() {
        "kb" => 1e3,
        "mb" => 1e6,
        "gb" => 1e9,
        "tb" => 1e12,
        _ => 1.0,
    };
    (n * mult) as u64
}

fn virtual_disks() -> Vec<VirtualDisk> {
    let mut v = Vec::new();
    let Some(local) = dirs::data_local_dir() else { return v };
    let candidates: Vec<(String, PathBuf)> = vec![
        ("Docker Desktop data".into(), local.join("Docker/wsl/disk/docker_data.vhdx")),
        ("Docker Desktop data".into(), local.join("Docker/wsl/data/ext4.vhdx")),
        ("Docker Desktop distro".into(), local.join("Docker/wsl/distro/ext4.vhdx")),
    ];
    let mut wsl: Vec<(String, PathBuf)> = std::fs::read_dir(local.join("Packages"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path().join("LocalState/ext4.vhdx");
            p.is_file().then(|| {
                let n = e.file_name().to_string_lossy().split('_').next().unwrap_or("WSL").to_string();
                (format!("WSL · {}", n.rsplit('.').next().unwrap_or(&n)), p)
            })
        })
        .collect();
    for (label, p) in candidates.into_iter().chain(wsl.drain(..)) {
        if let Ok(md) = std::fs::metadata(&p) {
            v.push(VirtualDisk { label, path: p.to_string_lossy().into_owned(), size: md.len() });
        }
    }
    v
}

pub fn report() -> DockerReport {
    let mut r = DockerReport { disks: virtual_disks(), ..Default::default() };
    match cmd("docker").arg("--version").output() {
        Ok(o) if o.status.success() => r.installed = true,
        _ => {
            r.error = Some("Docker CLI not found on PATH.".into());
            return r;
        }
    }
    match docker(&["version", "--format", "{{.Server.Version}}"]) {
        Ok(v) => {
            r.running = true;
            r.version = Some(v.trim().to_string());
        }
        Err(e) => {
            r.error = Some(if e.is_empty() { "Docker engine is not running.".into() } else { e });
            return r;
        }
    }

    if let Ok(s) = docker(&["system", "df", "--format", "{{json .}}"]) {
        r.df = json_lines(&s)
            .iter()
            .map(|v| DfRow {
                kind: field(v, "Type"),
                total: field(v, "TotalCount").parse().unwrap_or(0),
                active: field(v, "Active").parse().unwrap_or(0),
                size: parse_size(&field(v, "Size")),
                reclaimable: parse_size(&field(v, "Reclaimable")),
            })
            .collect();
    }

    let ids = docker(&["ps", "-aq", "--no-trunc"]).unwrap_or_default();
    let ids: Vec<&str> = ids.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let mut used: HashSet<String> = HashSet::new();
    if !ids.is_empty() {
        let mut args = vec!["inspect", "--format", "{{.Image}}"];
        args.extend(ids.iter().copied());
        if let Ok(s) = docker(&args) {
            used.extend(s.lines().map(|l| l.trim().to_string()));
        }
    }
    if let Ok(s) = docker(&["ps", "-a", "--format", "{{json .}}"]) {
        r.containers = json_lines(&s)
            .iter()
            .map(|v| DockerContainer {
                id: field(v, "ID"),
                name: field(v, "Names"),
                image: field(v, "Image"),
                state: field(v, "State"),
                status: field(v, "Status"),
                running_for: field(v, "RunningFor"),
            })
            .collect();
    }
    r.volumes = volumes();
    if let Ok(s) = docker(&["image", "ls", "--no-trunc", "--format", "{{json .}}"]) {
        r.images = json_lines(&s)
            .iter()
            .map(|v| {
                let id = field(v, "ID");
                let repo = field(v, "Repository");
                DockerImage {
                    in_use: used.contains(&id),
                    dangling: repo == "<none>",
                    size: parse_size(&field(v, "Size")),
                    created_at: field(v, "CreatedAt"),
                    created_since: field(v, "CreatedSince"),
                    tag: field(v, "Tag"),
                    repo,
                    id,
                }
            })
            .collect();
        r.images.sort_by(|a, b| b.size.cmp(&a.size));
    }
    r
}

fn volumes() -> Vec<DockerVolume> {
    let Ok(s) = docker(&["volume", "ls", "--format", "{{json .}}"]) else { return Vec::new() };
    let dangling: HashSet<String> = docker(&["volume", "ls", "-q", "--filter", "dangling=true"])
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_string())
        .collect();
    // Sizes come only from the verbose df; without them the list still works.
    let mut sizes = std::collections::HashMap::new();
    if let Ok(df) = docker(&["system", "df", "-v", "--format", "{{json .Volumes}}"]) {
        if let Ok(Value::Array(rows)) = serde_json::from_str::<Value>(df.trim()) {
            for v in rows {
                sizes.insert(field(&v, "Name"), parse_size(&field(&v, "Size")));
            }
        }
    }
    let mut v: Vec<DockerVolume> = json_lines(&s)
        .iter()
        .map(|v| {
            let name = field(v, "Name");
            DockerVolume {
                size: sizes.get(&name).copied().unwrap_or(0),
                in_use: !dangling.contains(&name),
                anonymous: name.len() == 64 && name.chars().all(|c| c.is_ascii_hexdigit()),
                driver: field(v, "Driver"),
                name,
            }
        })
        .collect();
    v.sort_by(|a, b| a.in_use.cmp(&b.in_use).then(b.size.cmp(&a.size)));
    v
}

fn hex_ids(ids: &[String]) -> bool {
    !ids.is_empty() && ids.iter().all(|i| !i.is_empty() && i.trim_start_matches("sha256:").chars().all(|c| c.is_ascii_hexdigit()))
}

/// Docker's own rule for volume names; also rules out anything that looks like a flag.
fn volume_names(ids: &[String]) -> bool {
    !ids.is_empty()
        && ids.iter().all(|n| {
            n.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
                && n.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
        })
}

/// Runs one of a fixed set of docker clean-ups on items the user picked.
/// Nothing here forces: Docker refuses running containers and volumes or images still in use.
pub fn action(kind: &str, ids: &[String]) -> Result<String, String> {
    let with = |base: &[&'static str], ids: &[String]| {
        let mut args: Vec<&str> = base.to_vec();
        args.extend(ids.iter().map(String::as_str));
        docker(&args)
    };
    match kind {
        "removeImages" if hex_ids(ids) => with(&["image", "rm"], ids),
        // No -v: a container's volumes are kept and show up in the volume list instead.
        "removeContainers" if hex_ids(ids) => with(&["container", "rm"], ids),
        "removeVolumes" if volume_names(ids) => with(&["volume", "rm"], ids),
        "pruneDangling" => docker(&["image", "prune", "-f"]),
        "pruneBuildCache" => docker(&["builder", "prune", "-f"]),
        "removeImages" | "removeContainers" | "removeVolumes" => Err("Invalid id".into()),
        _ => Err(format!("Unknown docker action {kind}")),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_docker_sizes() {
        assert_eq!(super::parse_size("1.5GB"), 1_500_000_000);
        assert_eq!(super::parse_size("512kB"), 512_000);
        assert_eq!(super::parse_size("0B"), 0);
        assert_eq!(super::parse_size("2.4GB (50%)"), 2_400_000_000);
    }

    #[test]
    fn rejects_unsafe_ids() {
        let v = |x: &[&str]| x.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(super::action("removeVolumes", &v(&["--all"])).is_err());
        assert!(super::action("removeVolumes", &v(&["a b"])).is_err());
        assert!(super::action("removeContainers", &v(&["web-1"])).is_err());
        assert!(super::action("pruneVolumes", &[]).is_err());
        assert!(super::action("pruneContainers", &[]).is_err());
        assert!(super::volume_names(&v(&["shop_pgdata", "0f3e"])));
    }

    #[test]
    fn protects_docker_data() {
        use crate::clean::protected;
        let local = dirs::data_local_dir().unwrap();
        assert!(protected(&local.join("Docker/wsl/disk/docker_data.vhdx")));
        assert!(protected(&local.join("Docker")));
        assert!(protected(&local));
        assert!(protected(std::path::Path::new(r"D:\wsl\Ubuntu\ext4.vhdx")));
        assert!(!protected(std::path::Path::new(r"C:\code\app\node_modules")));
        assert!(!protected(&dirs::home_dir().unwrap().join("code/app/target")));
    }
}
