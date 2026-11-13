fn main() {
    // scripts/release.sh and build.yml export MDPAD_UPDATE_ENDPOINT before `tauri build`.
    // option_env! in src/update.rs reads it. Declare the dependency here so a warm
    // target/ rebuilds when release.conf's UPDATE_ENDPOINT changes; otherwise the next
    // installer can keep the previous URL. Unset stays unset, and local builds keep
    // reporting that updates are not configured.
    println!("cargo:rerun-if-env-changed=MDPAD_UPDATE_ENDPOINT");
    if let Ok(endpoint) = std::env::var("MDPAD_UPDATE_ENDPOINT") {
        if !endpoint.is_empty() {
            println!("cargo:rustc-env=MDPAD_UPDATE_ENDPOINT={endpoint}");
        }
    }
    tauri_build::build()
}
