//! Container images, containers, volumes and caches through the engine's CLI (Docker, Podman or
//! nerdctl), so no daemon socket access is needed.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

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
    /// "Docker", "OrbStack", "Podman" or "nerdctl": the engine this report came from.
    pub engine: Option<String>,
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
    #[cfg(target_os = "macos")]
    c.env("PATH", tool_path());
    c
}

/// Apps opened from Finder get only /usr/bin:/bin:/usr/sbin:/sbin, which holds none of the tools
/// gnom drives. Shell profiles are not run for this: they can print, prompt or hang.
#[cfg(target_os = "macos")]
fn tool_path() -> &'static std::ffi::OsStr {
    static PATH: std::sync::OnceLock<std::ffi::OsString> = std::sync::OnceLock::new();
    PATH.get_or_init(|| {
        let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/Applications/Docker.app/Contents/Resources/bin"].map(PathBuf::from));
        if let Some(home) = dirs::home_dir() {
            for rel in [".orbstack/bin", ".docker/bin", ".rd/bin", ".local/bin", "Library/pnpm", ".volta/bin", ".bun/bin", ".cargo/bin", "go/bin"] {
                dirs.push(home.join(rel));
            }
            if let Ok(rd) = std::fs::read_dir(home.join(".nvm/versions/node")) {
                dirs.extend(rd.flatten().map(|e| e.path().join("bin")));
            }
        }
        std::env::join_paths(dirs).unwrap_or_default()
    })
}

/// Container CLIs gnom can drive, in the order it tries them. Docker Desktop, OrbStack and Rancher
/// Desktop (moby mode) ship `docker`, Rancher Desktop in containerd mode ships `nerdctl`, Podman ships `podman`.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Engine {
    Docker,
    Podman,
    Nerdctl,
}

impl Engine {
    const ALL: [Engine; 3] = [Engine::Docker, Engine::Podman, Engine::Nerdctl];

    fn bin(self) -> &'static str {
        match self {
            Engine::Docker => "docker",
            Engine::Podman => "podman",
            Engine::Nerdctl => "nerdctl",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Engine::Docker => "Docker",
            Engine::Podman => "Podman",
            Engine::Nerdctl => "nerdctl",
        }
    }

    /// Podman takes `--format json` and prints arrays; the others print one JSON object per line.
    fn json(self) -> &'static str {
        if self == Engine::Podman { "json" } else { "{{json .}}" }
    }

    fn run(self, args: &[&str]) -> Result<String, String> {
        let out = cmd(self.bin()).args(args).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    fn installed(self) -> bool {
        self.run(&["--version"]).is_ok()
    }

    /// The engine's version when its daemon or VM answers.
    fn server_version(self) -> Result<String, String> {
        if let Ok(v) = self.run(&["version", "--format", "{{.Server.Version}}"]) {
            if !v.trim().is_empty() && !v.contains("no value") {
                return Ok(v.trim().to_string());
            }
        }
        // nerdctl has no Server.Version; `info` only succeeds when the engine is up.
        self.run(&["info"])?;
        let v = self.run(&["--version"]).unwrap_or_default();
        Ok(v.split_whitespace().skip_while(|w| *w != "version").nth(1).unwrap_or("").trim_end_matches(',').to_string())
    }
}

/// The engine the last report talked to, so actions go to the same one.
static ACTIVE: Mutex<Option<Engine>> = Mutex::new(None);

fn active() -> Result<Engine, String> {
    if let Some(e) = *ACTIVE.lock().unwrap() {
        return Ok(e);
    }
    Engine::ALL.into_iter().find(|e| e.server_version().is_ok()).ok_or_else(|| "No container engine is running".into())
}

/// One JSON object per line, or a single array.
fn json_rows(s: &str) -> Vec<Value> {
    let t = s.trim();
    if t.starts_with('[') {
        serde_json::from_str(t).unwrap_or_default()
    } else {
        t.lines().filter_map(|l| serde_json::from_str(l.trim()).ok()).collect()
    }
}

/// First non-empty of several field names; arrays are joined, numbers printed.
fn text(v: &Value, keys: &[&str]) -> String {
    for k in keys {
        let s = match v.get(*k) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", "),
            _ => String::new(),
        };
        if !s.is_empty() {
            return s;
        }
    }
    String::new()
}

/// A size or count given either as a number or as Docker's "1.2GB" text.
fn num(v: &Value, keys: &[&str]) -> u64 {
    for k in keys {
        match v.get(*k) {
            Some(Value::Number(n)) => return n.as_u64().unwrap_or(0),
            Some(Value::String(s)) if !s.is_empty() => return s.parse().unwrap_or_else(|_| parse_size(s)),
            _ => {}
        }
    }
    0
}

/// Docker-style "3 weeks ago" for engines that only give a unix time.
fn ago(unix: u64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let s = now.saturating_sub(unix);
    let (n, unit) = match s {
        0..=3599 => (s / 60, "minute"),
        3600..=86_399 => (s / 3600, "hour"),
        86_400..=1_209_599 => (s / 86_400, "day"),
        1_209_600..=5_183_999 => (s / 604_800, "week"),
        5_184_000..=31_535_999 => (s / 2_592_000, "month"),
        _ => (s / 31_536_000, "year"),
    };
    format!("{n} {unit}{} ago", if n == 1 { "" } else { "s" })
}

fn unix(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(Value::as_u64)
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

/// What the running engine calls itself: OrbStack answers through the `docker` CLI.
fn engine_label(e: Engine) -> String {
    if e == Engine::Docker {
        if let Ok(os) = e.run(&["info", "--format", "{{.OperatingSystem}}"]) {
            if os.to_ascii_lowercase().contains("orbstack") {
                return "OrbStack".into();
            }
        }
    }
    e.label().into()
}

/// The disks behind Docker Desktop and OrbStack on macOS, and behind every WSL distro on Windows
/// (Docker Desktop, Rancher Desktop, Podman machines, Ubuntu…).
#[cfg(target_os = "macos")]
fn virtual_disks() -> Vec<VirtualDisk> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    [
        ("OrbStack", "Library/Group Containers/HUAQ24HBR6.dev.orbstack/data/data.img.raw"),
        ("Docker Desktop", "Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw"),
    ]
    .into_iter()
    .filter_map(|(label, rel)| {
        let p = home.join(rel);
        let md = std::fs::metadata(&p).ok()?;
        Some(VirtualDisk { label: label.into(), path: p.to_string_lossy().into_owned(), size: crate::scan::disk_size(&md) })
    })
    .collect()
}

#[cfg(not(target_os = "macos"))]
fn virtual_disks() -> Vec<VirtualDisk> {
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    if let Some(local) = dirs::data_local_dir() {
        found.push(("Docker Desktop data".into(), local.join(r"Docker\wsl\disk\docker_data.vhdx")));
    }
    for d in crate::guard::wsl_distros() {
        let n = d.name.to_ascii_lowercase();
        let label = if n.starts_with("docker-desktop") {
            "Docker Desktop".to_string()
        } else if n.starts_with("rancher-desktop") {
            "Rancher Desktop".to_string()
        } else if n.starts_with("podman") {
            format!("Podman · {}", d.name)
        } else {
            format!("WSL · {}", d.name)
        };
        found.push((label, d.base.join("ext4.vhdx")));
    }
    let mut seen = HashSet::new();
    found
        .into_iter()
        .filter_map(|(label, p)| {
            let md = std::fs::metadata(&p).ok()?;
            seen.insert(p.to_string_lossy().to_lowercase()).then(|| VirtualDisk { label, path: p.to_string_lossy().into_owned(), size: md.len() })
        })
        .collect()
}

pub fn report() -> DockerReport {
    let mut r = DockerReport { disks: virtual_disks(), ..Default::default() };
    let installed: Vec<Engine> = Engine::ALL.into_iter().filter(|e| e.installed()).collect();
    if installed.is_empty() {
        r.error = Some("No container engine found. gnom works with Docker Desktop, OrbStack, Rancher Desktop and Podman.".into());
        return r;
    }
    r.installed = true;
    let mut first_err = None;
    let mut engine = None;
    for e in &installed {
        match e.server_version() {
            Ok(v) => {
                engine = Some(*e);
                r.version = Some(v);
                break;
            }
            Err(err) => {
                first_err.get_or_insert(if err.is_empty() { format!("{} is not running.", e.label()) } else { err });
            }
        }
    }
    *ACTIVE.lock().unwrap() = engine;
    let Some(e) = engine else {
        r.engine = Some(installed[0].label().into());
        r.error = first_err;
        return r;
    };
    r.running = true;
    r.engine = Some(engine_label(e));
    let fmt = e.json();

    if e != Engine::Nerdctl {
        if let Ok(s) = e.run(&["system", "df", "--format", fmt]) {
            r.df = json_rows(&s)
                .iter()
                .map(|v| DfRow {
                    kind: text(v, &["Type"]),
                    total: num(v, &["TotalCount", "Total"]),
                    active: num(v, &["Active"]),
                    size: num(v, &["RawSize", "Size"]),
                    reclaimable: num(v, &["RawReclaimable", "Reclaimable"]),
                })
                .collect();
        }
    }

    let rows = e.run(&["ps", "-a", "--no-trunc", "--format", fmt]).map(|s| json_rows(&s)).unwrap_or_default();
    // Images a container (running or stopped) was created from, by id where the engine says so.
    let mut used: HashSet<String> = rows.iter().map(|v| text(v, &["ImageID"])).filter(|s| !s.is_empty()).collect();
    if e != Engine::Podman {
        let ids: Vec<String> = rows.iter().map(|v| text(v, &["ID", "Id"])).filter(|s| !s.is_empty()).collect();
        if !ids.is_empty() {
            let mut args = vec!["inspect", "--format", "{{.Image}}"];
            args.extend(ids.iter().map(String::as_str));
            if let Ok(s) = e.run(&args) {
                used.extend(s.lines().map(|l| l.trim().to_string()));
            }
        }
    }
    r.containers = rows
        .iter()
        .map(|v| {
            let status = text(v, &["Status"]);
            let mut state = text(v, &["State"]).to_ascii_lowercase();
            if state.is_empty() {
                // nerdctl prints only "Up 3 hours" / "Exited (0) 2 days ago" / "Created".
                state = status.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
                if state == "up" {
                    state = "running".into();
                }
            }
            DockerContainer {
                id: text(v, &["ID", "Id"]),
                name: text(v, &["Names", "Name"]),
                image: text(v, &["Image"]),
                running_for: unix(v, "Created").map(ago).unwrap_or_else(|| text(v, &["RunningFor", "CreatedAt"])),
                state,
                status,
            }
        })
        .collect();
    let used_names: HashSet<String> = r.containers.iter().map(|c| c.image.clone()).collect();

    r.volumes = volumes(e);
    if let Ok(s) = e.run(&["image", "ls", "--no-trunc", "--format", fmt]) {
        r.images = json_rows(&s)
            .iter()
            .map(|v| {
                let id = text(v, &["ID", "Id"]);
                let (mut repo, mut tag) = (text(v, &["Repository"]), text(v, &["Tag"]));
                if repo.is_empty() {
                    // Podman: "docker.io/library/alpine:latest" in RepoTags.
                    let first = v.get("RepoTags").and_then(Value::as_array).and_then(|a| a.first()).and_then(Value::as_str).unwrap_or("");
                    match first.rsplit_once(':').filter(|(_, t)| !t.contains('/')) {
                        Some((r_, t)) => (repo, tag) = (r_.to_string(), t.to_string()),
                        None => (repo, tag) = ("<none>".into(), "<none>".into()),
                    }
                }
                let short = id.trim_start_matches("sha256:");
                let in_use = used.iter().any(|u| u.trim_start_matches("sha256:") == short)
                    || num(v, &["Containers"]) > 0
                    || used_names.contains(&format!("{repo}:{tag}"))
                    || (tag == "latest" && used_names.contains(&repo));
                DockerImage {
                    in_use,
                    dangling: repo == "<none>",
                    size: num(v, &["Size"]),
                    created_at: text(v, &["CreatedAt"]),
                    created_since: unix(v, "Created").map(ago).unwrap_or_else(|| text(v, &["CreatedSince"])),
                    tag,
                    repo,
                    id,
                }
            })
            .collect();
        r.images.sort_by(|a, b| b.size.cmp(&a.size));
    }
    r
}

fn volumes(e: Engine) -> Vec<DockerVolume> {
    let Ok(s) = e.run(&["volume", "ls", "--format", e.json()]) else { return Vec::new() };
    // Without a dangling list nothing counts as unused, so nothing can be picked for deletion.
    let dangling: Option<HashSet<String>> = e
        .run(&["volume", "ls", "-q", "--filter", "dangling=true"])
        .ok()
        .map(|out| out.lines().map(|l| l.trim().to_string()).collect());
    // Sizes come only from Docker's verbose df; without them the list still works.
    let mut sizes = std::collections::HashMap::new();
    if e == Engine::Docker {
        if let Ok(df) = e.run(&["system", "df", "-v", "--format", "{{json .Volumes}}"]) {
            for v in json_rows(&df) {
                sizes.insert(text(&v, &["Name"]), num(&v, &["Size"]));
            }
        }
    }
    let mut v: Vec<DockerVolume> = json_rows(&s)
        .iter()
        .map(|v| {
            let name = text(v, &["Name"]);
            DockerVolume {
                size: sizes.get(&name).copied().unwrap_or(0),
                in_use: dangling.as_ref().is_none_or(|d| !d.contains(&name)),
                anonymous: name.len() == 64 && name.chars().all(|c| c.is_ascii_hexdigit()),
                driver: text(v, &["Driver"]),
                name,
            }
        })
        .filter(|v| !v.name.is_empty())
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

/// Runs one of a fixed set of clean-ups on items the user picked, on the engine the report used.
/// Nothing here forces: engines refuse running containers and volumes or images still in use.
pub fn action(kind: &str, ids: &[String]) -> Result<String, String> {
    let valid = match kind {
        "removeImages" | "removeContainers" => hex_ids(ids),
        "removeVolumes" => volume_names(ids),
        "pruneDangling" | "pruneBuildCache" => true,
        _ => return Err(format!("Unknown docker action {kind}")),
    };
    if !valid {
        return Err("Invalid id".into());
    }
    let e = active()?;
    let with = |base: &[&'static str]| {
        let mut args: Vec<&str> = base.to_vec();
        args.extend(ids.iter().map(String::as_str));
        e.run(&args)
    };
    match kind {
        "removeImages" => with(&["image", "rm"]),
        // No -v: a container's volumes are kept and show up in the volume list instead.
        "removeContainers" => with(&["container", "rm"]),
        "removeVolumes" => with(&["volume", "rm"]),
        "pruneDangling" => e.run(&["image", "prune", "-f"]),
        _ if e == Engine::Podman => e.run(&["image", "prune", "-f", "--build-cache"]),
        _ => e.run(&["builder", "prune", "-f"]),
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
    fn reads_docker_and_podman_rows() {
        use serde_json::json;
        let podman = super::json_rows(r#"[{"Id":"ab12","RepoTags":["docker.io/library/alpine:3.20"],"Size":7797760,"Created":1,"Containers":0}]"#);
        assert_eq!(podman.len(), 1);
        assert_eq!(super::num(&podman[0], &["Size"]), 7_797_760);
        assert!(super::ago(1).ends_with("years ago"));
        let docker = super::json_rows("{\"ID\":\"sha256:cd\",\"Size\":\"1.5GB\",\"Names\":\"web\"}\n{\"ID\":\"ef\"}\n");
        assert_eq!(docker.len(), 2);
        assert_eq!(super::num(&docker[0], &["Size"]), 1_500_000_000);
        assert_eq!(super::text(&json!({"Names": ["a", "b"]}), &["Names"]), "a, b");
        assert_eq!(super::text(&json!({"Total": 3}), &["TotalCount", "Total"]), "3");
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

    /// Talks to the real engine: `cargo test --lib real_report -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_report() {
        let r = super::report();
        println!("engine={:?} running={} version={:?} error={:?}", r.engine, r.running, r.version, r.error);
        println!("{} images, {} containers, {} volumes, {} df rows", r.images.len(), r.containers.len(), r.volumes.len(), r.df.len());
        for d in &r.disks {
            println!("{:>8} MB  {} {}", d.size >> 20, d.label, d.path);
        }
    }

}
