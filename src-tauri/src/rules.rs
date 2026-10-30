//! Which folders count as regenerable dev junk, and where machine-wide caches live.

use crate::model::Category;
use std::collections::HashSet;
use std::path::PathBuf;

pub struct Rule {
    pub category: Category,
    pub label: &'static str,
    pub regen: Option<&'static str>,
    pub tags: Vec<&'static str>,
    pub note: Option<&'static str>,
}

fn rule(category: Category, label: &'static str, regen: Option<&'static str>) -> Rule {
    Rule { category, label, regen, tags: vec![], note: None }
}

/// Names of the files and folders sitting next to the candidate, lowercased.
pub struct Siblings<'a> {
    pub names: &'a HashSet<String>,
}

impl Siblings<'_> {
    fn has(&self, name: &str) -> bool {
        self.names.contains(name)
    }
    fn any(&self, names: &[&str]) -> bool {
        names.iter().any(|n| self.has(n))
    }
    fn any_ext(&self, exts: &[&str]) -> bool {
        self.names.iter().any(|n| exts.iter().any(|e| n.ends_with(e)))
    }
}

const JS_MANIFEST: &[&str] = &["package.json"];
const GRADLE: &[&str] = &["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];
const DOTNET: &[&str] = &[".csproj", ".fsproj", ".vbproj", ".sln"];

/// Classifies a directory by its name and its siblings. `None` means "keep walking".
pub fn classify(name: &str, parent_name: &str, sib: &Siblings) -> Option<Rule> {
    use Category::*;
    let n = name.to_ascii_lowercase();
    let r = match n.as_str() {
        "node_modules" => rule(Deps, "node_modules", Some("npm / pnpm / yarn install")),
        "target" if sib.has("cargo.toml") => {
            let tauri = parent_name.eq_ignore_ascii_case("src-tauri") || sib.has("tauri.conf.json");
            let mut r = rule(Build, if tauri { "Tauri target" } else { "Rust target" }, Some("cargo build"));
            r.tags.push("rust");
            if tauri {
                r.tags.push("tauri");
                r.note = Some("Tauri builds keep debug + release WebView2 bundles and incremental caches; multi-GB is normal.");
            }
            r
        }
        ".next" => rule(Build, ".next", Some("next build")),
        ".nuxt" | ".output" if sib.any(&["nuxt.config.ts", "nuxt.config.js", "package.json"]) => rule(Build, "Nuxt build", Some("nuxt build")),
        ".svelte-kit" => rule(Build, ".svelte-kit", Some("vite build")),
        ".angular" => rule(Cache, ".angular cache", Some("ng build")),
        ".turbo" => rule(Cache, ".turbo", Some("turbo run")),
        ".parcel-cache" => rule(Cache, ".parcel-cache", Some("parcel build")),
        ".vite" => rule(Cache, ".vite", Some("vite")),
        ".expo" => rule(Cache, ".expo", Some("expo start")),
        ".docusaurus" | ".astro" | ".vercel" | ".netlify" => rule(Cache, leak(&n), None),
        "dist" | "out" | "build" | "storybook-static" if sib.any(JS_MANIFEST) => rule(Build, "JS build output", Some("npm run build")),
        "coverage" | ".nyc_output" if sib.any(JS_MANIFEST) => rule(Cache, "Test coverage", Some("npm test -- --coverage")),
        "build" if sib.any(GRADLE) || sib.has("pubspec.yaml") || sib.has("cmakelists.txt") => rule(Build, "Build output", Some("re-run the build")),
        ".gradle" if sib.any(GRADLE) => rule(Cache, ".gradle", Some("gradle build")),
        "bin" | "obj" if sib.any_ext(DOTNET) => rule(Build, ".NET bin/obj", Some("dotnet build")),
        "__pycache__" | ".pytest_cache" | ".mypy_cache" | ".ruff_cache" | ".tox" | ".nox" => rule(Cache, leak(&n), None),
        ".dart_tool" => rule(Cache, ".dart_tool", Some("flutter pub get")),
        "pods" if sib.has("podfile") => rule(Deps, "CocoaPods", Some("pod install")),
        "deriveddata" => rule(Build, "Xcode DerivedData", Some("xcodebuild")),
        ".terraform" => rule(Deps, ".terraform", Some("terraform init")),
        ".zig-cache" | "zig-cache" | "zig-out" => rule(Cache, leak(&n), Some("zig build")),
        ".cxx" | ".externalnativebuild" => rule(Build, "Android native build", Some("gradle build")),
        _ if n.starts_with("cmake-build-") => rule(Build, "CMake build", Some("cmake --build")),
        _ => return None,
    };
    Some(r)
}

/// Python virtualenvs are recognised by their pyvenv.cfg, whatever they are called.
pub fn venv_rule() -> Rule {
    rule(Category::Deps, "Python venv", Some("python -m venv && pip install -r requirements.txt"))
}

fn leak(s: &str) -> &'static str {
    // Labels are tiny and come from a fixed set of match arms; leaking keeps Rule 'static.
    Box::leak(s.to_string().into_boxed_str())
}

/// Files whose presence makes a folder a project root, and the stack they imply.
pub const MANIFESTS: &[(&str, &str)] = &[
    ("package.json", "node"),
    ("cargo.toml", "rust"),
    ("pyproject.toml", "python"),
    ("requirements.txt", "python"),
    ("go.mod", "go"),
    ("pom.xml", "java"),
    ("build.gradle", "java"),
    ("build.gradle.kts", "kotlin"),
    ("pubspec.yaml", "flutter"),
    ("composer.json", "php"),
    ("gemfile", "ruby"),
    ("deno.json", "deno"),
    ("cmakelists.txt", "c++"),
];

pub fn large_file_reason(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "pdb" | "dsym" | "debug" => "Debug symbols",
        "exe" | "dll" | "so" | "dylib" | "lib" | "a" | "rlib" | "node" => "Binary",
        "zip" | "7z" | "rar" | "tar" | "gz" | "tgz" | "xz" | "bz2" | "zst" => "Archive",
        "mp4" | "mov" | "mkv" | "avi" | "webm" | "wav" | "flac" => "Media",
        "iso" | "img" | "vhd" | "vhdx" | "vmdk" | "qcow2" | "vdi" => "Disk image",
        "log" | "out" => "Log",
        "sqlite" | "sqlite3" | "db" | "dump" | "sql" | "bak" | "mdf" | "ldf" => "Database / dump",
        "apk" | "aab" | "ipa" | "msi" | "dmg" | "appimage" | "deb" | "rpm" | "msix" => "Installer / package",
        "onnx" | "safetensors" | "pt" | "pth" | "ckpt" | "gguf" | "h5" | "tflite" | "bin" => "Model weights / blob",
        "dmp" | "core" | "hprof" | "heapsnapshot" => "Crash / heap dump",
        "psd" | "blend" | "fbx" | "glb" | "obj" | "tif" | "tiff" | "raw" => "Design asset",
        _ => "Large file",
    }
}

pub struct GlobalCache {
    pub id: &'static str,
    pub label: &'static str,
    pub path: PathBuf,
    pub command: Option<&'static str>,
    pub note: Option<&'static str>,
}

/// Machine-wide caches. Each is optional: only those that exist get reported.
pub fn global_caches() -> Vec<GlobalCache> {
    let home = dirs::home_dir().unwrap_or_default();
    let local = dirs::cache_dir().unwrap_or_else(|| home.join(".cache"));
    let data = dirs::data_local_dir().unwrap_or_else(|| local.clone());
    let mut v: Vec<GlobalCache> = Vec::new();
    let mut add = |id, label, path: PathBuf, command, note| v.push(GlobalCache { id, label, path, command, note });

    add("npm", "npm cache", if cfg!(windows) { data.join("npm-cache") } else { home.join(".npm") }, Some("npm cache clean --force"), None);
    add("pnpm", "pnpm store", if cfg!(windows) { data.join("pnpm").join("store") } else if cfg!(target_os = "macos") { home.join("Library/pnpm/store") } else { home.join(".local/share/pnpm/store") }, Some("pnpm store prune"),
        Some("Prune keeps packages still linked by a project; deleting the folder forces full re-downloads."));
    add("pnpm-cache", "pnpm metadata cache", if cfg!(windows) { data.join("pnpm-cache") } else { local.join("pnpm") }, None, None);
    add("yarn", "Yarn cache", if cfg!(windows) { data.join("Yarn").join("Cache") } else if cfg!(target_os = "macos") { local.join("Yarn") } else { local.join("yarn") }, Some("yarn cache clean"), None);
    add("bun", "Bun cache", home.join(".bun").join("install").join("cache"), Some("bun pm cache rm"), None);
    add("node-gyp", "node-gyp headers", if cfg!(windows) { data.join("node-gyp").join("Cache") } else { local.join("node-gyp") }, None, None);
    add("electron", "Electron downloads", if cfg!(windows) { data.join("electron").join("Cache") } else { local.join("electron") }, None, None);
    add("playwright", "Playwright browsers", if cfg!(windows) { data.join("ms-playwright") } else { local.join("ms-playwright") }, None,
        Some("Re-download with `npx playwright install`."));
    add("cypress", "Cypress binaries", if cfg!(windows) { data.join("Cypress").join("Cache") } else { local.join("Cypress") }, None, None);
    add("puppeteer", "Puppeteer browsers", home.join(".cache").join("puppeteer"), None, None);
    add("cargo-registry", "Cargo registry", home.join(".cargo").join("registry"), None,
        Some("Crates re-download on next build. `cargo install cargo-cache` gives finer control."));
    add("cargo-git", "Cargo git checkouts", home.join(".cargo").join("git"), None, None);
    add("pip", "pip cache", if cfg!(windows) { data.join("pip").join("Cache") } else { local.join("pip") }, Some("pip cache purge"), None);
    add("uv", "uv cache", if cfg!(windows) { data.join("uv").join("cache") } else { home.join(".cache").join("uv") }, Some("uv cache clean"), None);
    add("poetry", "Poetry cache", if cfg!(windows) { data.join("pypoetry").join("Cache") } else { local.join("pypoetry") }, None, None);
    add("gradle", "Gradle caches", home.join(".gradle").join("caches"), None, None);
    add("maven", "Maven repository", home.join(".m2").join("repository"), None, None);
    add("nuget", "NuGet packages", home.join(".nuget").join("packages"), Some("dotnet nuget locals all --clear"), None);
    add("go", "Go module cache", home.join("go").join("pkg").join("mod"), Some("go clean -modcache"), None);
    add("go-build", "Go build cache", if cfg!(windows) { data.join("go-build") } else { local.join("go-build") }, Some("go clean -cache"), None);
    add("deno", "Deno cache", if cfg!(windows) { data.join("deno") } else { local.join("deno") }, None, None);
    add("composer", "Composer cache", if cfg!(windows) { data.join("Composer") } else if cfg!(target_os = "macos") { home.join(".composer").join("cache") } else { local.join("composer") }, Some("composer clear-cache"), None);
    add("huggingface", "Hugging Face models", home.join(".cache").join("huggingface"), None,
        Some("Downloaded model weights; they come back on next use but can be large to re-fetch."));
    add("pub", "Dart pub cache", if cfg!(windows) { data.join("Pub").join("Cache") } else { home.join(".pub-cache") }, Some("dart pub cache clean"), None);
    add("android-gradle", "Android build cache", home.join(".android").join("cache"), None, None);
    add("vscode-cpptools", "VS Code C++ IntelliSense", if cfg!(windows) { data.join("Microsoft").join("vscode-cpptools") } else { local.join("vscode-cpptools") }, None, None);
    add("typescript", "TS server cache", if cfg!(windows) { data.join("Microsoft").join("TypeScript") } else { local.join("typescript") }, None, None);
    add("turbo", "Turborepo cache", if cfg!(windows) { data.join("turborepo") } else { local.join("turborepo") }, None, None);
    #[cfg(target_os = "macos")]
    {
        add("xcode", "Xcode DerivedData", home.join("Library/Developer/Xcode/DerivedData"), None, None);
        add("ios-device-support", "iOS DeviceSupport", home.join("Library/Developer/Xcode/iOS DeviceSupport"), None,
            Some("Symbols for devices you have connected. Xcode copies them again the next time you plug one in."));
        add("cocoapods", "CocoaPods cache", local.join("CocoaPods"), Some("pod cache clean --all"), None);
        add("homebrew", "Homebrew downloads", local.join("Homebrew"), None, None);
    }
    v.into_iter().filter(|c| c.path.is_dir()).collect()
}

/// Looks up the shell command behind a cache id; the UI can only ask for ids, never raw commands.
pub fn cache_command(id: &str) -> Option<&'static str> {
    global_caches().into_iter().find(|c| c.id == id).and_then(|c| c.command)
}
