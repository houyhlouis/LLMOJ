# Local development

[简体中文](Development.zh-CN.md) | English | [Wiki home](Home.en.md)

This page runs LLMOJ from a source checkout for development: a disposable MariaDB, Redis and MinIO of its own, the backend, the frontend's development server, optional sample data, and how to stop and remove it all. Nothing is installed on the system and nothing needs root. To install a site, see [Installation](Installation.md) instead; building and the test suites are described in the [development guide](../README-DEVELOPMENT.md).

## What you need

- Linux (amd64 or arm64) with the [toolchain](../README-DEVELOPMENT.md#toolchain): Node.js 24.21 and pnpm 11.13.1.
- The programs of the services: `mariadbd`, `mariadb-install-db` and `mariadb` (MariaDB 11), `redis-server`, and a MinIO server binary: set `LLMOJ_MINIO_BINARY` to its path, or put it at `runtime/minio` in the checkout (an installed site has one in its own `runtime/`).
- `flock` (util-linux) and Python 3.9 or later: the script uses them to make sure it only ever stops the processes it started itself.
- Seven free ports in a row on `127.0.0.1`, from 28400 by default: the backend (28400), its metrics (28401), the frontend (28402), MariaDB (28403), Redis (28404), MinIO (28405) and the MinIO console (28406). `start --base-port N` uses another range, and the stack remembers it.

Judging isn't part of the stack: submissions wait until a judge is connected (see [below](#judging)).

## 1. Build

```bash
pnpm install --frozen-lockfile
pnpm build:artifacts
pnpm --filter @libreoj/backend build
```

## 2. Start the services

```bash
node deploy/dev/stack.mjs start --dir /var/tmp/llmoj-dev-$(id -u)
```

- `--dir` is where everything goes: the databases, logs, generated configuration and credentials, all readable only by you. It defaults to `.dev-stack/` in the checkout, which Git ignores. On Ubuntu, AppArmor lets MariaDB use data directories only under `/tmp`, `/var/tmp` and its own paths, so use a directory under `/var/tmp`, as above; the script says so when MariaDB fails to start.
- The first `start` creates the database `llmoj_dev` with the current schema (with [`deploy/initialize-schema.mjs`](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/initialize-schema.mjs)), the storage bucket, and the administrator `admin` (with `deploy/bootstrap-admin.mjs`, as the installer does). It writes `backend.yaml`, made from `apps/backend/config-example.yaml` with random development-only secrets, and `backend.env`, which points the backend at it and keeps its AI, archive and temporary files inside the stack.
- It prints the addresses, where the administrator's password is (`admin-credentials.json`), and the commands of the next step. Running `start` again after a `stop` starts the same services with their data.

## 3. Start the backend and the frontend

In two terminals, from the checkout:

```bash
(cd apps/backend && . /var/tmp/llmoj-dev-$(id -u)/backend.env && node dist/main)
```

```bash
node deploy/dev/stack.mjs frontend --dir /var/tmp/llmoj-dev-$(id -u)
```

Open `http://127.0.0.1:28402` and sign in as `admin`. The frontend's development server reloads as you change `packages/frontend`, and passes `/api` (with live updates) on to the backend. After changing the backend, build it again and restart its terminal. The backend also answers on `http://127.0.0.1:28400`, with its OpenAPI description at `/docs` (see [Using the API](API.md)), and its metrics are at `http://127.0.0.1:28401/metrics`.

## 4. Add sample data

```bash
node deploy/dev/stack.mjs seed --dir /var/tmp/llmoj-dev-$(id -u)
```

This adds an ordinary user `dev_student` (its password is in `student-credentials.json`), a public traditional problem, "Double an integer", with a sample and two test cases, and one C++ submission, canceled because there's no judge. Run it once per stack. For benchmarks, use the separate kit described in [Capacity](Capacity.md#repeating-the-measurement), on a fresh stack of its own.

## Judging

A judge needs root, cgroup v2 and the sandbox image, so the stack doesn't start one. To judge submissions, connect a judge machine to this backend as to any site: register it on the site's **Judge Machine** page and set it up as described in [Distributed judging](Distributed-Judging.md) and [Remote judges](Remote-Judge.md). Until then, submissions wait in the queue.

## Tests

The test suites don't need the stack: see [Tests](../README-DEVELOPMENT.md#tests) in the development guide. Suites that use a database expect a disposable MariaDB of their own (see [Database tests](../README-DEVELOPMENT.md#database-tests)).

## 5. Stop and remove

Stop the backend and the frontend with Ctrl-C first. Then:

```bash
node deploy/dev/stack.mjs stop --dir /var/tmp/llmoj-dev-$(id -u)
```

stops MariaDB, Redis and MinIO and keeps their data (`start` brings them back), and

```bash
node deploy/dev/stack.mjs reset --dir /var/tmp/llmoj-dev-$(id -u)
```

stops them and deletes the directory with everything in it. Both act only on a directory the script created, and stop only the processes it recorded starting, so other MariaDB, Redis or MinIO servers on the machine (an installed site's, for example) are never touched.

## If something goes wrong

- **A port is in use:** `start` names it. For a new stack, choose another range with `--base-port`. A stack keeps its ports: free the port, or `reset` the stack and start a new one with another range.
- **MariaDB doesn't start:** read `mariadb.log` in the stack directory. On Ubuntu, use a directory under `/var/tmp` (AppArmor).
- **No MinIO binary:** set `LLMOJ_MINIO_BINARY`.
- **The schema or the administrator couldn't be created:** build the backend first (step 1); `schema.log` has the details.
- The services' logs are `mariadb.log`, `redis.log` and `minio.log` in the stack directory. Errors print no credentials.
