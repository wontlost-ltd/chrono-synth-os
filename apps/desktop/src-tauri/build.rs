use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    tauri_build::build();

    // Tell Cargo to re-run if the CLI override env changes.
    println!("cargo:rerun-if-env-changed=CHRONO_SCHEMA_DSL_CLI");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set by Cargo"));
    let generated_path = out_dir.join("migrations_generated.rs");

    let cli = resolve_schema_dsl_cli();
    let status = Command::new("node")
        .arg(&cli)
        .arg("--out")
        .arg(&generated_path)
        .status()
        .expect("failed to invoke schema-dsl render-rust CLI");

    if !status.success() {
        panic!(
            "schema-dsl render-rust CLI failed with status {:?} (cli={})",
            status,
            cli.display(),
        );
    }
}

fn resolve_schema_dsl_cli() -> PathBuf {
    // 1. Explicit env override (used by developer worktrees + CI overrides)
    if let Ok(p) = env::var("CHRONO_SCHEMA_DSL_CLI") {
        return PathBuf::from(p);
    }

    // 2. Production path: node_modules/.bin (after `npm install @wontlost-ltd/schema-dsl`)
    //    src-tauri/build.rs runs from src-tauri/, so node_modules is one level up.
    let from_node_modules = PathBuf::from("..")
        .join("node_modules")
        .join(".bin")
        .join("schema-dsl-render-rust");
    if from_node_modules.exists() {
        return from_node_modules;
    }

    // 3. Alternative: direct require path under node_modules (in case .bin symlink isn't present)
    let from_pkg = PathBuf::from("..")
        .join("node_modules")
        .join("@wontlost-ltd")
        .join("schema-dsl")
        .join("bin")
        .join("render-rust.js");
    if from_pkg.exists() {
        return from_pkg;
    }

    panic!(
        "Cannot find @wontlost-ltd/schema-dsl CLI. Either:\n\
         - run `npm install @wontlost-ltd/schema-dsl` in the desktop repo (production path), or\n\
         - set CHRONO_SCHEMA_DSL_CLI to the path of bin/render-rust.js in your worktree."
    );
}
