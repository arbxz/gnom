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
            })
            .collect();
    }
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

/// Runs one of a fixed set of docker clean-ups. Image ids are validated as hex digests.
pub fn action(kind: &str, ids: &[String]) -> Result<String, String> {
    match kind {
        "removeImages" => {
            if ids.is_empty() || !ids.iter().all(|i| i.trim_start_matches("sha256:").chars().all(|c| c.is_ascii_hexdigit())) {
                return Err("Invalid image id".into());
            }
            let mut args = vec!["image", "rm"];
            args.extend(ids.iter().map(String::as_str));
            docker(&args)
        }
        "pruneDangling" => docker(&["image", "prune", "-f"]),
        "pruneContainers" => docker(&["container", "prune", "-f"]),
        "pruneBuildCache" => docker(&["builder", "prune", "-f"]),
        "pruneVolumes" => docker(&["volume", "prune", "-f"]),
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
}
