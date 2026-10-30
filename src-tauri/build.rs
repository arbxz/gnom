fn main() {
    // tauri-build only watches tauri.conf.json; without this a new icon never reaches the exe.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.macos.conf.json");
    tauri_build::build()
}
