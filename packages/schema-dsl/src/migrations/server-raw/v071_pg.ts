import { defineRaw, rawSql } from '../../dsl/raw.js';

export const v071_pg_pgvector: ReturnType<typeof defineRaw> = defineRaw({
  id: 'pgvector-embeddings',
  version: 'v071',
  aliases: { postgres: 'v071' },
  description: 'pgvector stage 2: add embedding vector column + HNSW index + dims trigger',
  reason: 'PG-only pgvector + HNSW + trigger',
  postgres: rawSql([
    `CREATE EXTENSION IF NOT EXISTS vector`,
    `ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS embedding vector(1536)`,
    `ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS embedding_model TEXT`,
    `ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS embedding_dims INTEGER`,
    `CREATE OR REPLACE FUNCTION validate_embedding_dims() RETURNS TRIGGER AS $$
       BEGIN
         IF NEW.embedding IS NOT NULL AND vector_dims(NEW.embedding) <> NEW.embedding_dims THEN
           RAISE EXCEPTION 'embedding_dims (%) does not match vector(%) length',
             NEW.embedding_dims, vector_dims(NEW.embedding);
         END IF;
         RETURN NEW;
       END $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS memory_embeddings_dims_check ON memory_embeddings`,
    `CREATE TRIGGER memory_embeddings_dims_check
       BEFORE INSERT OR UPDATE ON memory_embeddings
       FOR EACH ROW EXECUTE FUNCTION validate_embedding_dims()`,
    `CREATE INDEX IF NOT EXISTS memory_embeddings_vec_cos_idx
       ON memory_embeddings
       USING hnsw (embedding vector_cosine_ops)
       WITH (m = 16, ef_construction = 64)`,
    `CREATE INDEX IF NOT EXISTS memory_embeddings_tenant_model_idx
       ON memory_embeddings (tenant_id, embedding_model)`,
  ]),
});
