# 0004 — Field-level encryption with envelope keys

**Status:** Accepted
**Date:** 2025-Q4
**Scope:** `src/storage/encryption.ts`, all PII-bearing tables

## Context

Persona data is intimate: memories, values, beliefs, conversation history.
Some of that — names, emails, calendar events arriving from the agent
toolchain — is regulated PII under GDPR and CCPA. Two questions: where to
encrypt, and which key encrypts what.

Disk-level encryption (LUKS, EBS) protects against a stolen disk, but not
against a leaked DB dump or a backup mounted on a laptop. Column-level
encryption inside the application solves both. The remaining question is
how to manage keys without forcing every read to round-trip a KMS.

## Decision

**Field-level AES-256-GCM with envelope encryption.**

- Each tenant has a long-lived **Key Encryption Key (KEK)** in cloud KMS
  (AWS KMS / GCP KMS / Azure KeyVault — the adapter picks).
- Each row that stores PII generates a random 32-byte **Data Encryption Key
  (DEK)** at write time. The DEK encrypts the field; the KEK encrypts the
  DEK. Both ciphertexts are stored in the row.
- Reading: fetch the row, ask KMS to decrypt the DEK once, decrypt the
  field. The plaintext DEK never leaves process memory.
- A small in-memory LRU caches DEKs for 5 minutes per tenant — most reads
  hit the same handful of personas, so the KMS round trip is amortized.

KMS is exposed through a `KmsClient` port; tests use an in-memory KEK that
the testkit provides.

## Consequences

**Wins**

- A leaked DB dump is useless without KMS access.
- Per-row DEKs limit blast radius — compromising one row's DEK reveals one
  row, not the table.
- Per-tenant KEK lets us crypto-shred a tenant on offboarding (delete the
  KEK; ciphertext is unrecoverable). This satisfies GDPR Right-to-Erasure
  without VACUUM-like rewrites.
- Adapter swap is one file; no leakage to domain code.

**Costs**

- Reads cost one extra symmetric decrypt (~µs) per encrypted field. The
  DEK cache makes the KMS hop a once-per-5-min event.
- Migrations that touch encrypted columns must go through the encryption
  layer; raw `UPDATE table SET col = ?` is forbidden by lint rule.
- Backup/restore is asymmetric — restoring a backup into a different
  account requires re-wrapping every DEK against the new KEK.

## Alternatives considered

- **Disk-level encryption only:** rejected — doesn't help against backup
  exfiltration or insider DB access.
- **Single tenant KEK encrypting fields directly:** rejected — millions of
  fields per tenant means rotating the KEK rewrites the whole tenant. With
  envelopes, KEK rotation only re-wraps the DEKs, which is constant work
  per row.

## Related

- `src/storage/encryption.ts`
- `docs/operations/disaster-recovery-runbook.md` § crypto-shredding
