# Disaster Recovery Runbook

## 目标

满足 `ChronoSynth-OS-v1-Enterprise-Readiness` 中的 P0-6：

- 自动化数据库备份
- 自动化存储备份
- 7 天保留策略
- 可执行恢复脚本

## 脚本

- `scripts/backup_db.sh`
- `scripts/restore_db.sh`
- `scripts/backup_storage.sh`
- `scripts/test_disaster_recovery.sh`

## 环境变量

- `CHRONO_DB_DRIVER`
  - `sqlite` 或 `postgres`
- `CHRONO_DB_PATH`
  - SQLite 文件路径
- `CHRONO_DB_CONNECTION_STRING`
  - PostgreSQL 连接串
- `CHRONO_STORAGE_PATH`
  - 需要打包备份的存储目录
- `CHRONO_BACKUP_DIR`
  - 备份输出目录，默认 `./backups`
- `BACKUP_RETENTION_DAYS`
  - 默认 `7`

## 本地执行

### 备份 SQLite

```bash
CHRONO_DB_DRIVER=sqlite \
CHRONO_DB_PATH=./data/chrono.db \
bash scripts/backup_db.sh
```

### 备份 PostgreSQL

```bash
CHRONO_DB_DRIVER=postgres \
CHRONO_DB_CONNECTION_STRING='postgresql://chrono:chrono@localhost:5432/chrono_synth' \
bash scripts/backup_db.sh
```

### 备份存储目录

```bash
CHRONO_STORAGE_PATH=./data \
bash scripts/backup_storage.sh
```

### 恢复 SQLite

```bash
CHRONO_DB_DRIVER=sqlite \
CHRONO_DB_PATH=./data/chrono.db \
bash scripts/restore_db.sh ./backups/db/chrono-sqlite-20260313T000000Z.db.gz
```

### 恢复 PostgreSQL

```bash
CHRONO_DB_DRIVER=postgres \
CHRONO_DB_CONNECTION_STRING='postgresql://chrono:chrono@localhost:5432/chrono_synth' \
bash scripts/restore_db.sh ./backups/db/chrono-postgres-20260313T000000Z.sql.gz
```

## Podman 计划任务示例

```bash
0 2 * * * cd /path/to/chrono-synth-os && CHRONO_DB_DRIVER=postgres CHRONO_DB_CONNECTION_STRING='postgresql://chrono:chrono@localhost:5432/chrono_synth' bash scripts/backup_db.sh
15 2 * * * cd /path/to/chrono-synth-os && CHRONO_STORAGE_PATH=./data bash scripts/backup_storage.sh
```

## 仓库内验证

CI 现在会直接执行：

```bash
npm run test:ops
```

该命令不再只是 shell 语法检查，还会实际完成一轮：

1. 创建 SQLite 测试数据库
2. 执行数据库备份
3. 删除原数据库并执行恢复
4. 校验恢复后的业务记录仍存在
5. 执行存储目录打包并验证归档内容

## 恢复演练建议

每次版本发布前至少执行一次：

1. 生成数据库备份
2. 在隔离环境恢复到新库或新文件
3. 启动应用并执行：
   - `GET /healthz`
   - `GET /readyz`
   - 关键登录 / persona / billing smoke test
4. 验证租户数据、persona core、wallet、governance、audit 数据完整

## 验收标准

- 备份文件可生成
- 7 天外备份会自动清理
- 恢复脚本支持 SQLite / PostgreSQL
- 恢复后服务可以通过健康检查
