# Development and builds

English | [简体中文](README-DEVELOPMENT.zh-CN.md)

LLMOJ is based on LibreOJ and keeps the main MIT license and component notices. See the [README](README.md) and [Wiki](wiki/Home.md).

## Toolchain

Node >=22.13; the installer pins 24.21.0. Use package.json's pnpm 11.13.0. Native builds need Linux amd64, CMake, C++, libfmt; execution also needs namespaces and cgroup v2.

```bash
pnpm install --frozen-lockfile
pnpm build:artifacts
pnpm --filter simple-sandbox build
pnpm build:native
pnpm build
pnpm check-types
```

Source archives include testlib. Run `git submodule update --init --recursive` only if its files are missing.

## Runtime configuration

config/*.example are templates. Real config, credentials, data, dependencies, rootfs and build output stay out of source releases. The installer generates them, defaulting to 0.0.0.0:80; internal services stay local. Services retain libreoj-* names and /opt/LibreOJ paths. HYHOJ_* variables remain for existing code compatibility; display names use --site-name / OJ_SITE_NAME.

Docker builds rootfs; native simple-sandbox executes submissions. Both installer entry points share the same backend logic, selecting English or Chinese messages. Their standalone bootstrap code is checked for equivalence. See [Docker sources](wiki/Docker-Sources.md).

## Checks and source packaging

```bash
node --test deploy/test/bootstrap-admin.test.mjs
python3 deploy/test/github-entry.test.py
python3 deploy/test/docker-support.test.py
sudo python3 deploy/test/install-support.test.py
sudo python3 deploy/test/install-network.test.py
sudo python3 deploy/test/judge-config.test.py
python3 deploy/prepare-github.py --archive release/llmoj-source.tar.gz
```

Use disposable instances for database/browser integration tests, respecting the constraints in apps/backend/src/ai/README.md. Never use production data or sessions as fixtures. Packaging/exporting only creates local files; it never commits, pushes or publishes.
