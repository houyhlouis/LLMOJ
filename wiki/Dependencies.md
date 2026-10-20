# Dependencies and toolchain

[简体中文](Dependencies.zh-CN.md) | English | [Wiki home](Home.en.md)

LLMOJ pins its toolchain and locks every package it uses in `pnpm-lock.yaml`. This page lists the supported versions, what isn't upgraded yet and why, how to check the locked packages for known advisories, and how dependencies are changed.

## Supported versions

| Part | Version | Notes |
| --- | --- | --- |
| Node.js | 24.21.0 (`.node-version`) | A long-term support release, supported until April 2028. The installer downloads this build and checks its hash; the [upgrader](Upgrade.md) refuses a different one. |
| pnpm | 11.13.1 (`packageManager` in `package.json`) | Installs and builds the workspace; the upgrader refuses a different version. |
| TypeScript | 6.0 | The last release with the JavaScript compiler API, which the backend's build and the linter use. Every package uses the same version (`catalog` in `pnpm-workspace.yaml`). |
| ESLint | 10, with typescript-eslint 8 | The rules are airbnb-base's, kept in `eslint.airbnb-base.mjs`, since that package supports no ESLint after 8. |
| Prettier | 3 | |
| Backend | NestJS 11, Express 5, TypeORM 0.3, Socket.IO 4.8, mysql2 3 | |
| Judge | node-addon-api 8 and cmake-js 8 | The native add-ons are built against the installed Node.js, without downloads. |
| Server | Ubuntu 26.04 on amd64 | See [Installation](Installation.md). |

## Not upgraded yet

These newer releases need changes of their own. Each is a separate step, not part of a routine update:

- **NestJS 12** is published only as ES modules, and the backend is built as CommonJS. Moving the backend to ES modules comes first.
- **TypeORM 1** is a major release of the database layer, with renamed and removed APIs. It needs its own migration and a review of the schema it makes. TypeORM 0.3.31 is maintained and has the fixes for the known advisories.
- **TypeScript 7** isn't supported by typescript-eslint yet (which supports TypeScript before 6.1), and the NestJS build tools use the compiler API that TypeScript 7 replaces.
- **Node.js 26** becomes a long-term support release at the end of October 2026, while Node.js 24 is supported until April 2028. The upgrader doesn't change Node.js.
- **pnpm 12** changes no package, so it can wait for a Node.js change.
- **ioredis 6** and **ejs 7** are new major releases; ioredis 5.11 and ejs 3.1.10 are maintained.
- **jsondiffpatch 0.7**: the backend's copy makes the live updates that browsers apply with theirs, so both change together, with the frontend.

## How the schema stays the same

TypeORM after 0.3.7 makes tables a little differently: JSON columns become MariaDB's JSON type (`utf8mb4_bin`, with a `json_valid` check), and one-to-one columns that are already the primary key get no unique index. The entities state what existing installations have: `JsonColumn` (`apps/backend/src/database/json-column.ts`) stores JSON in `longtext`, and the `REL_…` unique indexes are declared by name. Old and new installations therefore have the same schema, which the upgrader's [database contracts](Community-Upgrade.md) expect.

After changing the database libraries, check that a structure-only copy of an existing database needs no change: `deploy/upgrade-schema.mjs --action audit` must report no queries.

## Inventory and advisories

From the repository, after `pnpm install`:

```bash
node deploy/dependency-audit.mjs sbom sbom.cdx.json
node deploy/dependency-audit.mjs audit
```

- `sbom` writes a [CycloneDX](https://cyclonedx.org/) inventory of every locked package: its version, registry address and SHA-512 hash, and whether only development uses it.
- `audit` asks the npm registry's advisory service about the locked versions (through `pnpm audit`) and places each advisory by the most exposed way the packages reach it:
  - **server**: a production dependency of the backend, the judge, the judge protocol or the sandbox;
  - **browser**: a frontend package other than its build tools, which may be in the pages browsers run;
  - **build**: build, test and development tools, and the bootstrap packages no installation runs.

Critical and high advisories in server code block: `audit` exits with status 1 unless `deploy/dependency-triage.json` accepts them. Browser code doesn't block until the frontend's build is replaced in the next release. Each accepted advisory records whether it is unreachable or an accepted risk, why, and a review date. After that date it blocks again, so that it is looked at again. Prefer updating the package; accept an advisory only when you've checked that its code isn't reached, and say how in the reason.

The **Dependencies** workflow (`.github/workflows/dependencies.yml`) runs both commands whenever the dependencies or the triage change, and every week, because advisories are published about versions that haven't changed. The inventory and the report are kept with the run as `dependency-inventory`.

## Changing dependencies

1. Change the `package.json` files and run `pnpm install`, which updates the lockfile. Keep the toolchain above unless you mean to change it. Shared tools (TypeScript, Prettier, tsx, the Node.js types) are set once, in `catalog` in `pnpm-workspace.yaml`.
2. pnpm runs a package's install scripts only if `allowBuilds` in `pnpm-workspace.yaml` allows them. A new package with scripts stops the install until you add it there, as `true` (it needs them, such as a native build) or `false`.
3. Run `pnpm check`, the tests, and `node deploy/dependency-audit.mjs audit`. For the backend's database libraries, check the schema as above.
4. On a server, the upgrader's plan lists what the change installs: see [Upgrade](Upgrade.md#dependency-changes).
