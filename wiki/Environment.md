# Environment variables and maintenance scripts

[简体中文](Environment.zh-CN.md) | English | [Wiki home](Home.en.md) | [Configuration overview](Configuration.md)

Variables are grouped by what reads them. The old prefixes `LIBREOJ_`, `HYHOJ_` and `OJ_` are still in use; don't rename them.

Setting a variable in your shell doesn't affect a running service. To change a service's environment, add a systemd drop-in, run `systemctl daemon-reload` and restart the service (see [Operations](Operations-Configuration.md#systemd-services)). Don't paste secret values into bug reports or logs.

## Services

| Variable | Meaning |
| --- | --- |
| `LIBREOJ_CONFIG_FILE` | Path of the backend's YAML file (required); `<root>/config/backend.yaml` when installed |
| `LIBREOJ_JUDGE_CONFIG_FILE` | Path of the judge's YAML file (required); `<root>/config/judge.yaml` when installed |
| `LIBREOJ_JUDGE_LOG_LEVEL` | Judge log level: `error`, `warn`, `info` (default) or `debug` |
| `LIBREOJ_SCHEMA_SYNC` | Whether the backend may change the database structure when it starts. Installed services never do this unless it's exactly `1`; `0` turns it off everywhere. Installations create the database with `deploy/initialize-schema.mjs`, and the [upgrader](Upgrade.md) applies checked changes and sets this to `0`. Don't turn it on to get round the upgrader's checks. |
| `LIBREOJ_LOG_SQL` | Log every SQL query. Any non-empty value turns it on, even `0` or `false`; remove the variable to turn it off. |
| `NODE_ENV` | `production` in the installed services, which also makes the backend log only warnings and errors |
| `NODE_OPTIONS` | `--max-old-space-size=512` in the installed services and `2300` for builds: the Node.js heap size in MiB, not the total memory of the process or of programs it runs |
| `UV_THREADPOOL_SIZE` | Judge thread pool, at least twice the number of judge slots plus two; the judge configuration sets it. See [Judge configuration](Judge-Configuration.md). |
| `TMPDIR` | `<root>/data/tmp` for the backend; must be writable by `libreoj` |
| `PATH` | The services use the installation's own Node.js (`<root>/runtime/node/bin`) first, which may differ from the one in your shell |
| `LIBREOJ_MIGRATION_CONFIG_FILE` | Makes the backend run the one-off migration from old LibreOJ instead of serving the site; see [below](#migrating-from-old-libreoj) |

The AI variables `HYHOJ_AI_STATE_DIR`, `HYHOJ_AI_GENERATED_DIR`, `HYHOJ_AI_SAMPLE_INPUTS_DIR`, `HYHOJ_AI_RUNNER_SOCKET`, `HYHOJ_ARCHIVE_WORK_DIRECTORY` and `HYHOJ_AI_PRIVATE_HOSTS` are described in [AI environment](AI-Environment.md).

The registration mode chosen in **Site management** is stored in the database, not in an environment variable; see [Registration approval](Registration-Approval.md).

## Installer and configuration scripts

These are read by the installer and the scripts that generate configuration. They never change configuration that already exists.

| Variable | Meaning |
| --- | --- |
| `HYHOJ_ROOT` | Installation directory for the configuration scripts and backups; `/opt/LLMOJ` by default. Setting it doesn't move an installation. |
| `NODE_BINARY` | Node.js used by the scripts; `<root>/runtime/node/bin/node` by default |
| `HYHOJ_PORT` | The site's port; `80` by default |
| `HYHOJ_PUBLIC_ORIGIN` | The site's public address; the installer passes the one you chose |
| `OJ_LISTEN_ADDRESS` | `0.0.0.0` (default) or `127.0.0.1` |
| `OJ_INSTALL_ROLE` | `all` (default) or `web`. It can't switch an existing installation to another role. |
| `OJ_SITE_NAME` | Site name for a new `backend.yaml` and for the frontend build; `LLMOJ` by default |
| `OJ_JUDGE_REMOTE` | `1` to configure a remote judge; `0` by default |
| `OJ_JUDGE_SERVER` | The site's address, for a remote judge (required) |
| `OJ_JUDGE_KEY_FILE` | Absolute path of the remote judge's key file, owned by root with mode `0600` (required) |
| `OJ_JUDGE_SLOTS` | Number of judge slots for a new `judge.yaml`. Without it, the automatic number is used (see [Installation](Installation.md#choosing-the-number-of-judge-slots)); `0` isn't accepted here. `HYHOJ_JUDGE_SLOTS` is an older name, read only when `OJ_JUDGE_SLOTS` isn't set. |
| `LLMOJ_INSTALL_LANG` | Language of the installer's messages: `zh-CN` for Chinese, anything else for English. `install.sh` and `install.zh-CN.sh` set it. |
| `LLMOJ_LANG` | Language of the upgrade and resize scripts' messages: `zh-CN` for Chinese, anything else for English. The `.zh-CN.sh` entry scripts set it to `zh-CN`; the others to `en`. |
| `OJ_SOURCE_REPOSITORY`, `OJ_SOURCE_COMMIT` | The repository and commit the download script installed, recorded for reference |
| `LIBREOJ_ROOT` | Installation directory for `bootstrap-admin.mjs` when `--root` isn't given; `/opt/LLMOJ` by default |
| `INVOCATION_ID`, `JOURNAL_STREAM` | Set by systemd. The administrator script uses them to avoid printing passwords into service logs; don't set them yourself. |

## Builds and the sandbox image

| Variable | Meaning |
| --- | --- |
| `HYHOJ_PUBLIC_DIR`, `HYHOJ_QUOTE_FILE`, `PNPM_BINARY` | Frontend build settings; see [Frontend configuration](Frontend-Configuration.md) |
| `CMAKE_BUILD_PARALLEL_LEVEL` | Parallel jobs for native builds; the installer uses `2` |
| `npm_config_nodedir` | Node.js headers for native builds; the installer uses `<root>/runtime/node` |
| `pnpm_config_verify_deps_before_run` | The installer sets it to `false` |
| `RUNTIME_DIRECTORY` | Where the sandbox image build keeps its files; `<repository>/runtime` by default |
| `OUTPUT_DIRECTORY` | Where the sandbox image archive is written; `<runtime>/sandbox-archives` by default |
| `LIBREOJ_X32_SUPPORTED` | `1` (default) or `0`. The installer uses `0` to skip the x32 test of the sandbox image on the host; the other tests still run. |
| `ARCHIVE`, `CHECKSUM`, `DESTINATION_PARENT` | Paths for installing a sandbox image archive, normally set by `deploy/sandbox/build.sh` |
| `BUILDX_BUILDER` | Docker Buildx builder; see [Docker sources](Docker-Sources.md#separate-judge-servers) |
| `CLOUDFLARE_WORKER_NAME`, `CLOUDFLARE_ACCOUNT_ID` | For the optional Cloudflare bootstrap build, which the installer doesn't use |
| `ALIYUN_ACCESS_KEY_ID`, `ALIYUN_ACCESS_KEY_SECRET`, `ALIYUN_OSS_BUCKET`, `ALIYUN_OSS_ENDPOINT` | For the optional Aliyun OSS bootstrap build, which uploads to external storage and isn't used by the installer |

The installer sets `NODE_OPTIONS`, `CMAKE_BUILD_PARALLEL_LEVEL`, `npm_config_nodedir` and `pnpm_config_verify_deps_before_run` itself, so setting them beforehand has no effect. The sandbox image ID (`ROOTFS_ID`) is calculated from the image recipe and can't be chosen.

Variables used only by tests are listed in the [development guide](../README-DEVELOPMENT.md#database-tests).

## Migrating from old LibreOJ

`LIBREOJ_MIGRATION_CONFIG_FILE` names a file with the old site's settings: `database.host` (text), `database.port` (number), `database.username`, `database.password` and `database.database` (text), and `uploads` (the old attachment directory). None has a default. The migration writes to the database; remove the variable once it's done. It isn't how you upgrade LLMOJ itself: use the [upgrader](Upgrade.md) for that.

## Maintenance scripts

| Script | Options and behavior |
| --- | --- |
| `upgrade.sh`, `upgrade.zh-CN.sh` | Upgrade the site: `--prefix`, `--plan`, `--ref`, `--source`, `--source-sha256`, `--apply --drained`, `--rollback BACKUP --drained`. `upgrade.sh` prints English, `upgrade.zh-CN.sh` Chinese. See [Upgrade](Upgrade.md). |
| `deploy/resize-judge.sh`, `deploy/resize-judge.zh-CN.sh` | Change the number of judge slots: `--prefix` (default `/opt/LLMOJ`), `--slots`, `--plan`, `--apply --drained`, `--rollback BACKUP --drained`, `--mode auto\|all\|remote`. `resize-judge.sh` prints English, `resize-judge.zh-CN.sh` Chinese. See [Judge configuration](Judge-Configuration.md). |
| `deploy/judge_capacity.py` | Show how many judge slots the server can run, without changing anything: `--remote`, `--json`, `--slots N` |
| `deploy/rebuild-statistics.sh` | Compare the submission and accepted counts with the submissions, and with `--apply` correct them; `--prefix`. See [Operations](Operations-Configuration.md#submission-and-accepted-counts). |
| `deploy/sandbox/self-test.sh` | Judge a few fixed programs with the installed judge to check the sandbox: `--prefix`, `--only cpp,java,…`. The upgrader runs it when the judge changes. |
| `deploy/sandbox/verify-installed.mjs` | Run real sandbox checks against the installation (`--root`, default `/opt/LLMOJ`) |
| `deploy/backup.sh` | Back up the site (`--prefix`); see [Operations](Operations-Configuration.md#backups) |
| `deploy/bootstrap-admin.mjs` | Create the first administrator: `--root`, `--config`, `--email` (default `admin@localhost.invalid`), `--show-credentials`. It isn't a way to reset a password. |
| `deploy/bootstrap-services.mjs` | Used by the installer: `--root` and `--phase storage\|judge\|verify-judge` create the storage bucket, register the local judge, or check its connection |
| `deploy/initialize-mariadb.py` | Used by the installer to create the database (`--root`); see [Installation](Installation.md#mariadb-initialization-failures-and-safe-retries) |
| `deploy/install-support.py` | Used by the installer for its individual steps; not for upgrades |
| `deploy/build-frontend-offline.mjs` | Build and publish the frontend: `--build`, `--assets-only`; see [Frontend configuration](Frontend-Configuration.md) |
| `deploy/docker-support.py` | Check Docker sources (`--source`, `--mirrors`), and with `--configure` write the mirrors to Docker's configuration without restarting Docker |
| `deploy/sandbox/build.sh` | Build the sandbox image: `plan` (default), `build`, or `stage ARCHIVE` |
| `deploy/export-wiki.py` | Export the wiki: `--repository OWNER/REPO --output DIR`; see [Publishing](Publishing.md) |
| `deploy/prepare-github.py` | Create a source archive (`--archive PATH`) from the files Git tracks; it never replaces an existing archive |

Sources: [configure-local.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-local.py), [configure-judge.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-judge.py), [install.sh](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/install.sh), [main.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/main.ts), [migration-config.schema.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/migration/migration-config.schema.ts), [judge config.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/config.ts).
