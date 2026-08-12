# Schema compatibility and upgrades

Docgen's human-owned records and persistent indexes use explicit integer schema
versions. The version is a compatibility boundary, not decoration.

## Read policy

- The current v1 engine reads schema version `1`.
- A governed human-owned record with no `schemaVersion` is legacy v0. Docgen
  reports it as pending; it does not silently rewrite it during another command.
- A version newer than the engine supports is rejected without changing the
  record or creating migration state. Upgrade Docgen before reading it.
- Invalid records fail validation. Docgen does not guess how to repair human
  intent.
- Rebuildable cache indexes are not migrated as human data. If incompatible,
  delete `.docgen/cache` and rebuild with `docgen index`.

## Upgrade policy

Run `docgen migrate --dry-run` first. An applied migration:

1. validates every source record and planned result;
2. stores the exact original bytes under `docs/.migrations/<migration-id>/before/`;
3. publishes all upgraded records with atomic writes; and
4. records hashes and paths in a schema-versioned receipt.

If publishing any record fails, Docgen restores the already-touched records.
`docgen migrate --rollback <migration-id>` restores the exact original bytes,
but refuses to proceed if a migrated record or backup has since changed. This
prevents rollback from overwriting later human work.

Migration tests cover dry runs, v0-to-v1 upgrades, exact rollback, rollback
conflicts, unsupported future versions, and interrupted-write recovery.

Generated Markdown does not use a mutable schema record. Its front matter
contains `engine_version` plus a SHA-256 `evidence_fingerprint`; regeneration is
the upgrade path. The fingerprint describes canonical extracted evidence, not
the enclosing Git commit, avoiding an impossible same-commit provenance loop.
