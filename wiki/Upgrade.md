# Upgrading

[简体中文](Upgrade.zh-CN.md) | English | [Wiki home](Home.en.md)

The upgrader installs a newer version of LLMOJ on a server set up by the installer, keeping your configuration and data: accounts, problems, submissions, files, AI settings and keys, judge slots, CPU settings and your own service customizations. It doesn't run the installer again or recreate the administrator.

It tests every database change on a copy of your database before touching the real one, and switches over only during a short maintenance window.

## What it supports

- Installations made by the installer, with the `all` or `web` role, using the default service layout and the local MariaDB, Redis and MinIO.
- Changes to the site's code, the judge and the sandbox. On an `all` installation, a changed sandbox or judge is rebuilt and tested before switching over (see [the judge self-test](Judge-Configuration.md#sandbox-syscall-filter-and-self-test)).
- The database changes made by LLMOJ's own features, each checked against its exact expected form. See [Feature upgrades](Community-Upgrade.md) for the list.

It refuses:
- installations managed with Git, custom layouts, custom database connections, `EnvironmentFile` overrides of the backend or judge, or custom AI directories;
- database differences it doesn't recognize, and changes to dependencies, lockfiles or the Node.js and pnpm versions (24.21.0 and 11.13.1);
- removing or changing values the judge protocol or the database already uses (new values may be added at the end).

These need a separate, planned migration. Don't get round a refusal by deleting data or reinstalling.

New installations go to `/opt/LLMOJ`; an installation in `/opt/LibreOJ` stays there, so pass `--prefix /opt/LibreOJ`.

## Planning

Download the upgrader and look at its plan first. `upgrade.sh` prints English and `upgrade.zh-CN.sh` Chinese; otherwise they're the same.

```bash
curl -fsSL https://raw.githubusercontent.com/houyhlouis/LLMOJ/main/upgrade.sh -o /tmp/llmoj-upgrade.sh
sudo bash /tmp/llmoj-upgrade.sh --prefix /opt/LLMOJ --plan
```

The script turns `main` into a specific commit before downloading it; use `--ref FULL_COMMIT_SHA` to install a particular commit. The plan checks the installation and lists what will be checked later. It doesn't build anything, copy the database or stop services, so a successful plan isn't a finished upgrade.

## Upgrading

1. Choose a quiet time. Stop new submissions, imports and AI jobs, and wait until all queued and running work has finished, including hacks, Self Eval runs and pretest preparation, and work on remote judges. The upgrader checks the database for running work, but can't stop remote judges for you.
2. Run the upgrader without `--plan`:

   ```bash
   sudo bash /tmp/llmoj-upgrade.sh --prefix /opt/LLMOJ
   ```

   It asks you to type `UPGRADE` to confirm that everything has finished. Without questions, use `--apply --drained` instead; `--drained` is your confirmation that work has stopped, and doesn't stop anything itself.

The upgrader then:
1. takes the maintenance lock, which keeps backups and judge resizing out, and checks the services and free disk space;
2. builds the new version with its own copy of the dependencies and checks the files;
3. backs up the configuration, the AI master key and the database, loads the backup into a temporary database, and tests every schema and data change there;
4. stops Nginx, the judge and the backend, makes a fresh database backup and checks it again;
5. switches to the new files and applies the database changes;
6. waits until the new backend is [ready](Operations-Configuration.md#liveness-and-readiness) (it reaches the database, Redis and object storage) and checks the local judge, then starts the services that were running before, Nginx last.

Backups and build logs stay in `<prefix>/backups/upgrade/<UTC time>-<random>/`, and the upgrader prints the path. They contain secrets, so keep them private, and delete old ones yourself when you no longer need them; the upgrader never deletes data or backups. After an upgrade completes, it deletes only the build's copy of the dependencies (`staging/node_modules`, about 1 GiB), which nothing uses afterwards, not even a rollback. Upgrade backups from before this version still hold that copy; [doctor](Operations-Configuration.md#doctor) tells you how many. For an upgrade that completed, you can delete it: `sudo rm -rf /opt/LLMOJ/backups/upgrade/<UTC time>-<random>/staging/node_modules`.

The upgrader installs `/etc/systemd/system/libreoj-backend.service.d/90-libreoj-schema-sync.conf`, which sets `LIBREOJ_SCHEMA_SYNC=0` so that the backend never changes the database structure by itself; the upgrader makes those changes explicitly. Your other drop-ins, the Nginx configuration, credentials and judge capacity are left alone.

Settings saved in the site, such as the [registration mode](Registration-Approval.md) and the homepage, are kept.

## Upgrading from a local source tree

To upgrade from a complete copy of the source you've reviewed (not a ZIP of changed files), use its own upgrader:

```bash
sudo bash /path/to/LLMOJ/deploy/upgrade.sh \
  --prefix /opt/LLMOJ --source /path/to/LLMOJ --plan
```

Check the `sourceSha256` it reports, then run it again with both `--source` and `--source-sha256 <the 64-digit digest>`. `python3 /path/to/LLMOJ/deploy/upgrade.py --source /path/to/LLMOJ --source-digest` prints the digest without changing anything. The digest shows the tree hasn't changed since you checked it; it doesn't make an unreviewed tree trustworthy.

## If the upgrade fails

- If building or testing on the database copy fails, the site keeps running the old version.
- If switching over fails, the upgrader tries to restore the old files and services. If that also fails, the site stays stopped and the upgrader tells you where its backup is. Never assume the site is fine after an error message.

Fix the cause and run the upgrader again with the same options. Database changes that were already made aren't repeated. Don't delete configuration, keys or the database to retry.

## Rolling back

Stop new work and wait for it to finish again, then give the backup directory the upgrader printed:

```bash
sudo bash /opt/LLMOJ/deploy/upgrade.sh --prefix /opt/LLMOJ \
  --rollback /opt/LLMOJ/backups/upgrade/ACTUAL_BACKUP --drained
```

This restores the old code. It keeps the current database and files, and never loads an old database backup over newer data; database backups are for disaster recovery, which you plan separately.

The upgrader refuses to roll back to a version that can't handle data you now have, because that version would ignore its rules. This applies when the site has teams, solutions, Fake or Hacked submissions, hack reference programs or history, Self Eval data, Strict IOI contests, saved contest options, the new permissions granted or denied, accounts with [two-factor sign-in](Two-Factor-Sign-In.md), a saved registration mode, or registration applications. In those cases fix the new version instead. For example:

- If a registration mode is saved in **Site management** and the old version doesn't have that page, first click **Restore server configuration** and check that the mode in `backend.yaml` is what you want.
- While there are pending or rejected registration applications, an old version could let those people sign in without approval, so rollback is refused. If the upgrade moved old pending or rejected accounts into applications, rollback stays refused even after they're approved.

## Registration approval migration

When upgrading from the first release with registration approval, the upgrader moves pending and rejected accounts into separate applications. It rehearses this on the database copy first and stops for manual review if any of these accounts has content, permissions, a custom profile or a conflicting username or email. See [Registration approval](Registration-Approval.md#upgrading). Don't upgrade by replacing only the frontend, and don't delete the old review tables.
