mod clean;
mod deps;
mod docker;
mod guard;
mod model;
mod rules;
mod scan;

use model::{Finding, ScanOptions, ScanResult};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct AppState {
    counters: Arc<scan::Counters>,
    /// Paths the last scan reported. `clean` refuses anything else, so a UI bug
    /// can never turn into deleting an arbitrary folder.
    allowed: Mutex<HashSet<String>>,
    scanning: AtomicBool,
}

/// The last scan lives on disk so the app reopens on real results instead of an empty screen.
fn cache_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("last-scan.json"))
}

fn write_cache(app: &AppHandle, result: &ScanResult) -> Result<(), String> {
    let path = cache_file(app).ok_or("No app data folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Write then rename, so a crash mid-write never leaves a half file behind.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(result).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn allow_findings(state: &AppState, result: &ScanResult) {
    let mut allowed = state.allowed.lock().unwrap();
    allowed.clear();
    allowed.extend(result.findings.iter().map(|f: &Finding| scan::key(std::path::Path::new(&f.path))));
}

/// Restores the previous session's results (and re-arms deletion for exactly those paths).
#[tauri::command]
fn load_last_scan(app: AppHandle, state: State<'_, AppState>) -> Option<ScanResult> {
    let bytes = std::fs::read(cache_file(&app)?).ok()?;
    let mut result: ScanResult = serde_json::from_slice(&bytes).ok()?;
    // A scan saved by an older version may list places gnom now leaves alone.
    result.findings.retain(|f| f.category == model::Category::Global || !guard::off_limits(std::path::Path::new(&f.path)));
    allow_findings(&state, &result);
    Some(result)
}

/// Persists the UI's copy after a clean, so removed items stay removed on next launch.
#[tauri::command]
fn save_scan(app: AppHandle, result: ScanResult) -> Result<(), String> {
    write_cache(&app, &result)
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
    allow_findings(&state, &result);
    if let Err(e) = write_cache(&app, &result) {
        eprintln!("could not cache scan: {e}");
    }
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanItem {
    path: String,
    size: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CleanProgress {
    freed: u64,
    total: u64,
    index: usize,
    count: usize,
    current: String,
}

#[tauri::command]
async fn clean_paths(app: AppHandle, state: State<'_, AppState>, items: Vec<CleanItem>, to_trash: bool) -> Result<Vec<CleanOutcome>, String> {
    let allowed: HashSet<String> = state.allowed.lock().unwrap().clone();
    let total: u64 = items.iter().map(|i| i.size).sum();
    let count = items.len();
    let freed = Arc::new(AtomicU64::new(0));
    let current = Arc::new(Mutex::new((0usize, String::new())));
    let done = Arc::new(AtomicBool::new(false));
    {
        let (app, freed, current, done) = (app.clone(), freed.clone(), current.clone(), done.clone());
        std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                let (index, path) = current.lock().unwrap().clone();
                let _ = app.emit("clean-progress", CleanProgress { freed: freed.load(Ordering::Relaxed), total, index, count, current: path });
                std::thread::sleep(Duration::from_millis(120));
            }
        });
    }
    let (f, c) = (freed.clone(), current.clone());
    let outcomes = tauri::async_runtime::spawn_blocking(move || {
        items
            .into_iter()
            .enumerate()
            .map(|(i, item)| {
                *c.lock().unwrap() = (i, item.path.clone());
                let before = f.load(Ordering::Relaxed);
                let res = if allowed.contains(&scan::key(std::path::Path::new(&item.path))) {
                    clean::remove(&PathBuf::from(&item.path), to_trash, item.size, &f)
                } else {
                    Err("Not part of the last scan; rescan first.".into())
                };
                // Sizes come from the scan; settle each finished item on its scanned size so the bar ends at 100%.
                if res.is_ok() {
                    let counted = f.load(Ordering::Relaxed) - before;
                    if counted < item.size {
                        f.fetch_add(item.size - counted, Ordering::Relaxed);
                    }
                }
                CleanOutcome { path: item.path, ok: res.is_ok(), error: res.err() }
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string());
    done.store(true, Ordering::Relaxed);
    let outcomes = outcomes?;
    let _ = app.emit("clean-progress", CleanProgress { freed: freed.load(Ordering::Relaxed), total, index: count, count, current: String::new() });
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
    let mut builder = tauri::Builder::default().manage(AppState::default());

    // Self-updater + process (relaunch after install) are desktop-only; mobile
    // stores handle their own updates.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            default_roots,
            load_last_scan,
            save_scan,
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
