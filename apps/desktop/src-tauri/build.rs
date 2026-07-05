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

    // We invoke the CLI as `node <path>`, so the path MUST be the real `.js` entry — NOT the
    // `node_modules/.bin/schema-dsl-render-rust` shim. On Linux/macOS that shim is a symlink to the
    // `.js` (so `node <shim>` happens to work), but on **Windows npm creates a bash/`.cmd`/`.ps1`
    // wrapper** instead of a symlink, and `node <bash-shim>` parses the shell script as JS →
    // `SyntaxError: missing ) after argument list` (Windows tauri build failure). So resolve the
    // package's `bin/render-rust.js` directly and NEVER hand a `.bin` shim to `node`.

    // 2. Installed package's real JS entry (after `npm install @wontlost-ltd/schema-dsl`).
    //    src-tauri/build.rs runs from src-tauri/, so node_modules is one level up.
    let from_pkg = PathBuf::from("..")
        .join("node_modules")
        .join("@wontlost-ltd")
        .join("schema-dsl")
        .join("bin")
        .join("render-rust.js");
    if from_pkg.is_file() {
        return from_pkg;
    }

    // Monorepo paths (ADR-0049): desktop is a workspace member, so deps hoist to the repo root
    // node_modules (not apps/desktop/node_modules). build.rs runs from apps/desktop/src-tauri/,
    // so the repo root is three levels up.
    //
    // CRITICAL: the source path resolves to the in-repo `packages/schema-dsl/bin/render-rust.js`,
    // which imports the package's built `dist/` output — and `dist/` is NOT git-tracked. So
    // `npm ci` links the package but does NOT build `dist/`. Only use this candidate when `dist/`
    // is actually built; otherwise node would crash with a cryptic module-not-found instead of the
    // helpful panic below.
    let workspace_root = PathBuf::from("..").join("..").join("..");
    let schema_dsl_pkg = workspace_root.join("packages").join("schema-dsl");
    let dist_src = schema_dsl_pkg.join("dist").join("src");
    let dist_built = dist_src
        .join("migrations")
        .join("desktop")
        .join("index.js")
        .is_file()
        && dist_src
            .join("renderers")
            .join("sqlite-rust-module.js")
            .is_file();

    if dist_built {
        // 3. the workspace package source `.js` directly (cross-platform safe; never a .bin shim).
        let from_workspace_pkg = schema_dsl_pkg.join("bin").join("render-rust.js");
        if from_workspace_pkg.is_file() {
            return from_workspace_pkg;
        }
    }

    panic!(
        "Cannot find a runnable @wontlost-ltd/schema-dsl CLI. Either:\n\
         - at the monorepo root run `npm ci` then `npm run -w @wontlost-ltd/schema-dsl build`\n\
           (npm ci hoists the package to root node_modules but does NOT build its dist/), or\n\
         - run a full `npm run build` at the root (tsc -b builds all packages incl. schema-dsl), or\n\
         - set CHRONO_SCHEMA_DSL_CLI to the path of bin/render-rust.js in your worktree."
    );
}
