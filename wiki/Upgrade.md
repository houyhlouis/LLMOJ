# Upgrading

[简体中文](Upgrade.zh-CN.md) | English | [Wiki home](Home.en.md)

The upgrader installs a newer version of LLMOJ on a server set up by the installer, keeping your configuration and data: accounts, problems, submissions, files, AI settings and keys, judge slots, CPU settings and your own service customizations. It doesn't run the installer again or recreate the administrator.

It tests every database change on a copy of your database before touching the real one, and switches over only during a short maintenance window.

## What it supports

- Installations made by the installer, with the `all` or `web` role, using the default service layout and the local MariaDB, Redis and MinIO.
- Changes to the site's code, the judge and the sandbox. On an `all` installation, a changed sandbox or judge is rebuilt and tested before switching over (see [the judge self-test](Judge-Configuration.md#sandbox-syscall-filter-and-self-test)).
- Changes to dependencies and the lockfile: see [Dependency changes](#dependency-changes).
- The database changes made by LLMOJ's own features, each checked against its exact expected form. See [Feature upgrades](Community-Upgrade.md) for the list.

It refuses:
- installations managed with Git, custom layouts, custom database connections, `EnvironmentFile` overrides of the backend or judge, or custom AI directories;
- database differences it doesn't recognize, and changes to the Node.js and pnpm versions (24.21.0 and 11.13.1; see [Dependencies](Dependencies.md));
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
2. builds the new version with its own copy of the dependencies, installing the new ones if they changed, checks the files, and checks that the new backend accepts your `config/backend.yaml`;
3. backs up the configuration, the AI master key and the database, loads the backup into a temporary database, and tests every schema and data change there;
4. stops Nginx, the judge and the backend, makes a fresh database backup and checks it again;
5. switches to the new files and applies the database changes;
6. waits until the new backend is [ready](Operations-Configuration.md#liveness-and-readiness) (it reaches the database, Redis and object storage) and checks the local judge, then starts the services that were running before, Nginx last.

The judge runs as the account `libreoj-judge`, and only its [sandbox launcher](Judge-Configuration.md#the-judges-account-and-its-sandbox-launcher) runs as root. On an `all` installation, the upgrader creates that account before the judge's self-test if it doesn't exist yet. The plan shows it as `judgeAccount`. An account of that name that can log in is refused. A rollback keeps the account; an older judge runs as root and doesn't use it.

Backups and build logs stay in `<prefix>/backups/upgrade/<UTC time>-<random>/`, and the upgrader prints the path. They contain secrets, so keep them private, and delete old ones yourself when you no longer need them; the upgrader never deletes data or backups. After an upgrade completes, it deletes only the build's copy of the dependencies (`staging/node_modules`, about 1 GiB), which nothing uses afterwards, not even a rollback. When the upgrade changed the dependencies, that copy became the installed one instead, and the previous dependencies stay in `previous/node_modules` for a rollback. Upgrade backups from before this version still hold that copy; [doctor](Operations-Configuration.md#doctor) tells you how many. For an upgrade that completed, you can delete it: `sudo rm -rf /opt/LLMOJ/backups/upgrade/<UTC time>-<random>/staging/node_modules`.

The upgrader installs `/etc/systemd/system/libreoj-backend.service.d/90-libreoj-schema-sync.conf`, which sets `LIBREOJ_SCHEMA_SYNC=0` so that the backend never changes the database structure by itself; the upgrader makes those changes explicitly. Your other drop-ins, the Nginx configuration, credentials and judge capacity are left alone.

Settings saved in the site, such as the [registration mode](Registration-Approval.md) and the homepage, are kept.

## The database at startup

Before it serves anything, the backend compares the database with the tables and columns its version uses, the same comparison the upgrader's schema check makes:

- **Something it needs is missing** (a table or a column): it doesn't start, and its log names what's missing. This happens when a database was restored from an older version, or the code was updated without the upgrader. Upgrade the database with the upgrader, or restore a backup that matches the installed version.
- **A column is defined differently, or an index is missing**: it starts, logs the first differences, and [doctor](Operations-Configuration.md#doctor) warns about them. The site works, though perhaps more slowly or less strictly; tell the project if an upgrade left such a difference.
- **What a newer version added** (columns, indexes): ignored, so a rollback starts as before.

`LIBREOJ_SCHEMA_CHECK=0` in the backend's environment skips the check, for example to export data from a damaged installation. Don't leave it set.

## Dependency changes

When the new version changes `package.json` files, `pnpm-lock.yaml`, `pnpm-workspace.yaml` or `.npmrc`, the upgrader installs the new lockfile (frozen: exactly the locked versions, checked against their hashes) into the build's copy of the dependencies. It downloads the new packages from the npm registry into `<prefix>/runtime/pnpm-store`, so the server needs to reach `registry.npmjs.org`. Only the packages that `allowBuilds` in `pnpm-workspace.yaml` allows run install scripts.

The plan shows the change as `dependencies`: how many packages the new lockfile has and how many it adds and removes, each changed direct dependency of the backend, judge, frontend, judge protocol and sandbox, and the packages allowed to run install scripts (`buildScriptsChanged` says whether that list changed).

With new dependencies, every native add-on is rebuilt and the sandbox check and the judge's self-test run, as for a sandbox change. The new dependencies are switched in with the code, during the maintenance window. A rollback, automatic or with `--rollback`, restores the previous ones from the backup.

The Node.js and pnpm versions can't change this way. An upgrade whose `packageManager` names another pnpm, or whose installer pins another Node.js, is refused. See [Dependencies](Dependencies.md) for the supported versions.

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
