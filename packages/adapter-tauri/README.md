# @chrono/adapter-tauri

> Tauri host adapter for `@chrono/kernel`. Reuses `@chrono/adapter-web`'s in-memory + UoW machinery; persists via Tauri `invoke()` commands.

License: MIT.

## Why a separate package?

Tauri's frontend runs in a webview and needs the same sync UoW that a browser does, but its persistence target is Rust SQLite (or any host-implemented store) reached via async `invoke()`. The split:

- `@chrono/adapter-web` — the kernel-facing in-memory + UoW machinery (works anywhere a JS runtime exists)
- `@chrono/adapter-tauri` — the Tauri-flavored `WebKVStore` that bridges to Rust

If you're not on Tauri, you can ignore this package.

## Quick start

JS side:

```ts
import { invoke } from '@tauri-apps/api/tauri';
import {
  InMemoryTables,
  WebUnitOfWork,
  WebPersistenceController,
  createExecutorRegistry,
  registerToolPermissionExecutors,
  TauriKVStore,
} from '@chrono/adapter-tauri';

const tables = new InMemoryTables();
const registry = createExecutorRegistry();
registerToolPermissionExecutors(registry);

const store = new TauriKVStore({ invoke });
const persistence = new WebPersistenceController(tables, store);
await persistence.hydrate();

const tx = new WebUnitOfWork(tables, registry);
tx.onCommit(() => persistence.onCommit());
```

Rust side: the host implements three Tauri commands matching `TauriKVStore`'s defaults (`chrono_kv_load`, `chrono_kv_save`, `chrono_kv_clear`). A reference Rust skeleton:

```rust
#[tauri::command]
async fn chrono_kv_load(key: String, state: tauri::State<'_, Db>) -> Result<Option<serde_json::Value>, String> {
  // SELECT snapshot FROM kv WHERE key=$1
}

#[tauri::command]
async fn chrono_kv_save(key: String, snapshot: serde_json::Value, state: tauri::State<'_, Db>) -> Result<(), String> {
  // INSERT INTO kv(key, snapshot) VALUES($1, $2) ON CONFLICT DO UPDATE …
}

#[tauri::command]
async fn chrono_kv_clear(key: String, state: tauri::State<'_, Db>) -> Result<(), String> {
  // DELETE FROM kv WHERE key=$1
}
```

Override the command names via `TauriKVStore({ invoke, commands: { … } })` if your host uses a different convention.

## Status

`0.1.0` — the JS side is fully tested via mock-invoke; the Rust handlers are host-specific and out of scope for this package. Adopters can copy the Rust skeleton above into their Tauri project.
