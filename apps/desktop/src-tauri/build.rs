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
    if from_node_modules.is_file() {
        return from_node_modules;
    }

    // 3. Alternative: direct require path under node_modules (in case .bin symlink isn't present)
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
    // CRITICAL: both the root `.bin` symlink (candidate 4) and the source path (candidate 5)
    // resolve to the SAME in-repo `packages/schema-dsl/bin/render-rust.js`, which imports the
    // package's built `dist/` output — and `dist/` is NOT git-tracked. So `npm ci` creates the
    // symlink but does NOT build `dist/`. We must only use these candidates when `dist/` is
    // actually built; otherwise node would crash with a cryptic module-not-found instead of the
    // helpful panic below. Guard BOTH candidates on `dist` being built (both import entrypoints).
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
        // 4. root node_modules/.bin symlink (after `npm ci` at the root).
        let from_root_bin = workspace_root
            .join("node_modules")
            .join(".bin")
            .join("schema-dsl-render-rust");
        if from_root_bin.is_file() {
            return from_root_bin;
        }
        // 5. the workspace package source directly (even if the .bin symlink isn't present).
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
