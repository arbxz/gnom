mod clean;
mod deps;
mod docker;
mod model;
mod rules;
mod scan;

use model::{Finding, ScanOptions, ScanResult};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
struct AppState {
    counters: Arc<scan::Counters>,
    /// Paths the last scan reported. `clean` refuses anything else, so a UI bug
    /// can never turn into deleting an arbitrary folder.
    allowed: Mutex<HashSet<String>>,
    scanning: AtomicBool,
}

#[tauri::command]
fn default_roots() -> Vec<String> {
    dirs::home_dir().map(|h| vec![h.to_string_lossy().into_owned()]).unwrap_or_default()
}

#[tauri::command]
async fn start_scan(app: AppHandle, state: State<'_, AppState>, opts: ScanOptions) -> Result<ScanResult, String> {
    if state.scanning.swap(true, Ordering::SeqCst) {
        return Err("A scan is already running".into());
    }
    let counters = state.counters.clone();
    counters.reset();
    let done = Arc::new(AtomicBool::new(false));
    {
        let (c, done, app) = (counters.clone(), done.clone(), app.clone());
        std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                let _ = app.emit("scan-progress", c.snapshot());
                std::thread::sleep(Duration::from_millis(150));
            }
        });
    }
    let c = counters.clone();
    let result = tauri::async_runtime::spawn_blocking(move || scan::run(&opts, &c)).await;
    done.store(true, Ordering::Relaxed);
    state.scanning.store(false, Ordering::SeqCst);
    let result = result.map_err(|e| e.to_string())?;
    let mut allowed = state.allowed.lock().unwrap();
    allowed.clear();
    allowed.extend(result.findings.iter().map(|f: &Finding| scan::key(std::path::Path::new(&f.path))));
    Ok(result)
}

#[tauri::command]
fn cancel_scan(state: State<'_, AppState>) {
    state.counters.cancel.store(true, Ordering::Relaxed);
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CleanOutcome {
    path: String,
    ok: bool,
    error: Option<String>,
}

#[tauri::command]
async fn clean_paths(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>, to_trash: bool) -> Result<Vec<CleanOutcome>, String> {
    let allowed: HashSet<String> = state.allowed.lock().unwrap().clone();
    let total = paths.len();
    let outcomes = tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .enumerate()
            .map(|(i, path)| {
                let _ = app.emit("clean-progress", (i, total, path.clone()));
                let res = if allowed.contains(&scan::key(std::path::Path::new(&path))) {
                    clean::remove(&PathBuf::from(&path), to_trash)
                } else {
                    Err("Not part of the last scan; rescan first.".into())
                };
                CleanOutcome { path, ok: res.is_ok(), error: res.err() }
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut allowed = state.allowed.lock().unwrap();
    for o in outcomes.iter().filter(|o| o.ok) {
        allowed.remove(&scan::key(std::path::Path::new(&o.path)));
    }
    Ok(outcomes)
}

#[tauri::command]
async fn run_cache_command(id: String) -> Result<String, String> {
    let command = rules::cache_command(&id).ok_or("No clean command for this cache")?;
    tauri::async_runtime::spawn_blocking(move || clean::run_shell(command, None)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn docker_report() -> Result<docker::DockerReport, String> {
    tauri::async_runtime::spawn_blocking(docker::report).await.map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DockerActionArgs {
    kind: String,
    #[serde(default)]
    ids: Vec<String>,
}

#[tauri::command]
async fn docker_action(args: DockerActionArgs) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || docker::action(&args.kind, &args.ids)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn check_deps(project: String) -> Result<deps::DepReport, String> {
    tauri::async_runtime::spawn_blocking(move || deps::check(&PathBuf::from(project))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    clean::reveal(&PathBuf::from(path))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Deep node_modules / target trees recurse a lot; give the walker roomy stacks.
    let _ = rayon::ThreadPoolBuilder::new().stack_size(8 << 20).build_global();
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            default_roots,
            start_scan,
            cancel_scan,
            clean_paths,
            run_cache_command,
            docker_report,
            docker_action,
            check_deps,
            reveal
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
