# Upgrading while preserving configuration and data

[简体中文](Upgrade.zh-CN.md) | English | [Wiki home](Home.en.md)

The updater supports **completed official one-click `all` and `web` deployments**. It updates application code and public assets while preserving accounts, problems, submissions, objects, AI settings/encryption keys, judge slots, CPU affinity and existing service customizations. It does not rerun the installer or administrator bootstrap.

## Compatibility

This release supports the official version-3 installation metadata, local MariaDB/Redis/MinIO, a single backend, Node 24.21.0 and pnpm 11.13.1. Runtime, lockfile, shared packages, judge/native code and rootfs recipes must match the supported target contract. Only known registration-review/application schema changes, explicit migration of legacy inactive empty accounts, and appending `ManageRegistrationReviews` to the known `user_privilege.privilegeType` enum are permitted. The enum expansion checks every existing value and its order; removal, renaming, reordering or unknown values are not supported.

The known repository-link, package-description and bootstrap-title branding changes are treated as metadata-only for compatibility. Only the specified LibreOJ-to-LLMOJ values in identified files are allowed; package names, dependencies, scripts, API/CDN endpoints and all other settings remain subject to the existing checks. Source integrity still uses the original file bytes.

Default service and AI/temporary-directory layouts are required. Backend/judge `EnvironmentFile` overrides or custom AI key/work paths are refused because their effective configuration cannot be verified by this release. Supported CPU, judge-slot and memory customizations are preserved.

This is **not an arbitrary historical-version upgrader**. Git-managed deployments, unknown layouts, custom database connections, unknown schema differences or dependency/native changes require a separate migration procedure. Do not bypass a refusal by deleting data or rerunning installation.

## One-step entry

Ensure the new files have been published to GitHub first:

```bash
curl -fsSL https://raw.githubusercontent.com/houyhlouis/LLMOJ/main/upgrade.sh -o /tmp/llmoj-upgrade.sh && \
  sudo bash /tmp/llmoj-upgrade.sh --prefix /opt/LibreOJ
```

Replace the prefix for a custom installation. The entry resolves `main` to a full commit before downloading its source. Use `--ref FULL_COMMIT_SHA` to select a reviewed revision; compatibility checks still apply.

For a read-only plan:

```bash
sudo bash /tmp/llmoj-upgrade.sh --prefix /opt/LibreOJ --plan
```

A plan checks deployment/runtime and lists deferred checks. It does not build, create a database clone or stop services, so a successful plan is not a completed upgrade.

## Maintenance and preservation

Pause new submissions/imports/AI tasks and drain queued/running jobs, including remote judges. Interactive execution requires typing `UPGRADE`. The tool also checks active database jobs, but cannot coordinate remote nodes on your behalf.

It acquires the maintenance lock, validates effective service paths and available space, builds using independent dependency copies, and verifies asset hashes. It privately backs up configuration, AI master key and SQL, then restores SQL to a temporary database to audit and test schema and registration-application migrations. Before cutover it stops Nginx/judge/backend, takes a fresh dump and repeats schema checks. After switching files, it checks backend/local-judge health and restores the original service states, opening Nginx last.

Backups and private build logs remain in `<prefix>/backups/upgrade/<UTC-random>/`; the terminal prints the path. Backups may contain secrets and must not be uploaded to GitHub. They are retained for your own retention policy; business data and backups are not deleted. Legacy inactive empty accounts are converted to independent applications under the strict rules below.

A dedicated `/etc/systemd/system/libreoj-backend.service.d/90-libreoj-schema-sync.conf` sets `LIBREOJ_SCHEMA_SYNC=0` to disable automatic schema writes at backend startup. The updater applies checked migrations explicitly. Unknown content using that filename is never overwritten. Other units/drop-ins, Nginx configuration, credentials and judge capacity remain unchanged.

## Migrating the first approval release

Pending/rejected applications now stay outside the site user table. Approval creates the account and assigns its site user ID. Before cutover the updater rehearses the migration on a database clone, then rechecks and applies it transactionally with application services stopped:

- Existing active/approved accounts keep their IDs, passwords and business data.
- Legacy inactive empty accounts matching the original defaults become applications with their password hashes, timestamps and review records preserved. Their empty account rows are removed; historical user IDs are not recycled.
- Business content, privileges, custom profiles, unknown references, cross-database foreign keys or identity conflicts stop migration for manual review while preserving data. Normal rejection audit history remains available for tracing.
- Old SQL is never automatically restored over current data. If deployment fails after data migration, older code may not understand applications; recovery conservatively leaves services stopped until the new deployment is repaired.

Do not replace only frontend assets or delete old review tables to upgrade. See [Registration approval](Registration-Approval.md) for behavior and limits.

## Automation and local sources

After arranging a drained maintenance window:

```bash
sudo bash /tmp/llmoj-upgrade.sh --prefix /opt/LibreOJ --apply --drained
```

`--drained` declares operator readiness; it does not cancel jobs automatically.

For a reviewed **complete source tree**, use its local entry:

```bash
sudo bash /path/to/LLMOJ/deploy/upgrade.sh \
  --prefix /opt/LibreOJ --source /path/to/LLMOJ --plan
```

Verify the reported `sourceSha256`, then supply both `--source` and `--source-sha256 FULL_64_HEX_DIGEST` for execution. `python3 /path/to/LLMOJ/deploy/upgrade.py --source /path/to/LLMOJ --source-digest` also computes the tree digest without writes. A hash detects changes but does not establish trust by itself. A ZIP containing only modified files is not a complete source tree.

## Failure, retry and rollback

Build/clone-validation failures keep the original running instance. Failures during cutover attempt code/service recovery. If automatic recovery fails, application services remain stopped and the private recovery location is reported. Do not assume success after a failure message.

After diagnosing the cause, retry with the same options. Known schema and application migrations are repeatable; already migrated applications are not duplicated. Do not remove configuration, keys or databases to retry.

For manual rollback, pause and drain again and use the printed backup from this instance:

```bash
sudo bash /opt/LibreOJ/deploy/upgrade.sh --prefix /opt/LibreOJ \
  --rollback /opt/LibreOJ/backups/upgrade/ACTUAL_BACKUP --drained
```

Rollback restores code and the updater's own guard state while preserving the database, objects and compatible review/application tables. It never imports an old dump over newer user data. This release conservatively refuses code rollback while legacy pending/rejected accounts or new pending/rejected applications exist, preventing an approval bypass; retain an approval-aware release and fix the problem instead. If unapproved accounts are detected only after stopping services, applications remain stopped until an approval-aware release is recovered. SQL backups are for separately planned disaster recovery.

If this upgrade migrated legacy pending/rejected inactive empty accounts, ordinary code rollback using that backup is still refused even after all those applications are approved. This prevents older code from losing access to migrated applications and review history. Repair the new deployment; restoring an older release requires a separately reviewed data-recovery plan.

Registration mode is preserved by upgrading. Enable `registrationMode: approval` separately using [Registration approval](Registration-Approval.md). A previous Nginx registration block must be adjusted manually.
