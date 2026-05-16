import { defineRaw, rawSql } from '../../dsl/raw.js';

export const v072_pg_drop_embedding_json: ReturnType<typeof defineRaw> = defineRaw({
  id: 'drop-embedding-json-legacy',
  version: 'v072',
  aliases: { postgres: 'v072' },
  description: 'pgvector stage 7: drop embedding_json column + ivf_centroids/ivf_meta tables',
  reason: 'Disabled in PR2 baseline — runs after pgvector ramp completes',
  disabled: true,
  postgres: rawSql([
    `ALTER TABLE memory_embeddings DROP COLUMN IF EXISTS embedding_json`,
    `DROP TABLE IF EXISTS ivf_centroids`,
    `DROP TABLE IF EXISTS ivf_meta`,
  ]),
});
