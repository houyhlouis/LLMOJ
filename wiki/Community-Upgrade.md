# Teams, solutions, moderation, Hack and self-evaluation upgrade

[简体中文](Community-Upgrade.zh-CN.md) | English | [Wiki home](Home.en.md)

This release changes the backend, frontend, shared protocol, judge task handlers and database. It supports four contest formats: NOI / OI, IOI, ICPC and Strict IOI. Updating static pages alone does not install it; do not enable automatic schema synchronization to migrate an unknown old database.

## Frozen additive contract

- Eight team tables: `team`, `team_member`, `team_member_group`, `team_resource`, `team_assignment`, `team_file`, `team_invitation` and `team_file_upload`. The last table tracks expiring reservations for concurrent and chunked uploads.
- Two Hack tables: `hack` and `hack_problem`; three self-evaluation tables: `self_eval_set`, `self_eval` and `self_eval_quota`. The community contract contains thirteen tables in total. Existing first-release Hack tables receive the nullable `hack_problem.standardContent` JSON-content field (`longtext` in MariaDB) for an independent STD source copy; legacy submission-reference configurations are preserved.
- File sizes in `file.size` and `team_file.size` widen from signed `int` to signed `bigint` through non-destructive `CHANGE` statements. The `team.quotaLimit` default and all existing team quotas become 10 GiB (10,737,418,240 bytes); existing usage, files and memberships are preserved. There is no separate team per-file limit. Only these exact known storage changes are accepted.
- `discussion.type varchar(20) NOT NULL DEFAULT 'Discussion'` and the `IDX_discussion_type` index.
- `Fake`, then `Hacked`, appended after all fourteen existing `submission.status` enum values, preserving their order and stored data. The intermediate Fake-only version is accepted.
- `contest.rule` widened from `varchar(8)` to `varchar(16)` by a non-destructive `CHANGE`, plus nullable `contest.ruleOptions longtext`, storing TypeORM `simple-json` options. Only `noi`, `ioi`, `acm` and `strictioi` rule values are accepted.
- Eight appended permissions: `ViewTeam`, `CreateTeam`, `ManageTeams`, `FakeSubmission`, `ViewHack`, `CreateHack`, `ManageHack` and `CreateSelfEval`. Existing privilege enum values and explicit per-user overrides remain intact; `user_permission_rule.permission` remains a string column.
- All registration-review/application and legacy empty-account safeguards remain active.

Ordinary discussions keep their category. Only recorded AI discussion IDs matching both problem and author are reclassified. Existing IDs, replies, formal accounts, problems and submission code are retained.

Existing community tables must match a supported frozen contract; the first Hack release receives its STD field only through the known addition above. Unknown columns, enum changes, nullability/default changes and destructive SQL are rejected. TypeORM's fixed unchanged index-rebuild pairs around known enum expansions are omitted only after checking their actual definitions; no DROP is executed.

The runtime transition is separately pinned in `deploy/community-runtime-contract.json`, whose digest is fixed in the upgrader. Only exact reviewed protocol and Hack/self-evaluation task files from the supported upstream, first community-delivery baseline or first deployed Hack/Self Eval release are accepted. This is a one-way transition, not permission to change dependencies, native code, rootfs recipes or arbitrary judge logic.

Default viewing/creation permissions inherit the site's policy. My teams is accessed from your own profile and lists only joined teams and pending applications. Joining by ID without approval does not make a team public. Global team management remains privileged. Solutions are embedded in problem pages and remain in My discussions. An explicit Fake allow or denial overrides the old Delete fallback.

Hack starts only from a specific submission detail; its list displays results only. Managers save trusted STD source in the problem code editor or select **Use as problem STD** on an accepted submission. Hackers do not enter a reference submission ID. Input validators reuse available problem programs or are maintained by managers. Successful records invalidate targets with effective zero score.

Hack details show one always-expanded testcase containing the Hack input and recorded target verdict, runtime and memory. Older records explicitly identify missing verdict details. Tables and long read-only input grow with the page; wide tables retain horizontal scrolling. Members is reached through **View all** in the home page's **Top Users** panel.

Self Eval exists only on problem pages in enabled NOI / OI contests; ordinary problem pages, submission details and other formats do not offer it. Before the contest, managers enter `make.cpp` and `std.cpp`, or use **AI: generate official data and Self Eval programs** to regenerate official data and bind matching program versions, then prepare a fixed hidden prediction set. Evaluation reuses the formal SPJ, and manual configuration requires no separate validator. The default allowance is 30 per participant for the whole contest. Sets are limited to twenty cases, 4 MiB per input or output, and 16 MiB for the encoded JSON. Earlier ordinary self-evaluation records and settings for other formats are retained without enabling new runs. See [Teams](Teams.md), [Solutions](Solutions.md), [Hacks](Hacks.md), [Self Eval](Self-Evaluation.md) and [Moderation](Submission-Moderation.md).

## Official installations

For the GitHub download entry, publish the complete changes to your main repository first, then use the target release's entry point following [Safe upgrade](Upgrade.md). A reviewed complete local source tree can instead be used through `--source` without publishing it first. Keep an existing `/opt/LibreOJ` prefix instead of moving it to the new-install default.

The upgrader rebuilds judge-protocol, type-checks the judge and runs its Hack regression, then builds the backend and frontend in staging. It audits the live schema, rehearses migration on a restored database copy, and takes a fresh backup before migration and cutover during a drained maintenance window. Configuration, AI keys, object storage, judge slots and supported service customizations remain intact. Update remote judges with the matching reviewed protocol and handlers before accepting new task types.

The combined Hack/self-evaluation runtime transition is automated only for the official `all` role. A `web` deployment needs separately coordinated remote judge updates; the automatic transition refuses it instead of assuming remote compatibility. The schema-synchronization guard is installed before the first community DDL statement and remains after a partial migration failure.

Read-only example using a complete target source tree:

```bash
sudo bash /path/to/complete-source/deploy/upgrade.sh \
  --prefix /opt/LibreOJ --source /path/to/complete-source --plan
```

A changed-files ZIP is not a complete `--source` tree. Overlay it onto a complete repository first. Follow the safe-upgrade guide for source-digest verification, maintenance confirmation and rollback.

## Custom deployments

The standalone helper defaults to audit. It connects only to the database and does not start Nest, workers or services, take backups or switch code. It requires a known mature schema; use the installer for a new empty database.

Prepare matching complete source and build it:

```bash
pnpm install --frozen-lockfile
pnpm build:artifacts
pnpm --filter @libreoj/judge run check-types
pnpm --filter @libreoj/backend run build
pnpm --filter @libreoj/frontend run build
```

Read-only audit:

```bash
node deploy/migrate-community-features.mjs \
  --root /path/to/complete-source \
  --config /path/to/instance/config/backend.yaml
```

Before applying, pause writes, drain local/remote judging and AI jobs, stop the backend and back up database/configuration. Rehearse against an isolated restored copy, then explicitly apply:

```bash
node deploy/migrate-community-features.mjs \
  --root /path/to/complete-source \
  --config /path/to/instance/config/backend.yaml --apply --drained
```

`--drained` is the operator's assertion, not an automatic drain or service-stop action. Drain ordinary judging, Hack tasks, prediction preparation, self-evaluation and AI jobs, including remote nodes. The connection needs DDL/data-migration rights; credentials are never printed. Start the new backend with `LIBREOJ_SCHEMA_SYNC=0`, publish matching web assets and judge handlers, verify the four formats, permissions, teams, solutions, moderation, Hack and self-evaluation, then reopen the site.

The reviewable `deploy/teams-migration.sql`, `deploy/solutions-migration.sql` and `deploy/fake-migration.sql` cover the original three-feature migration. They do not install the later Hack/self-evaluation tables, Hacked state, new permissions or contest fields by themselves. Use the current complete schema helper or official upgrader for the combined release. Direct SQL does not replace backup, schema-audit and cutover checks.

## Repeatability and rollback

Reapplying is safe; a completed audit has no pending schema changes, team quota updates or verified AI solutions to classify. Investigate unknown schemas instead of deleting tables, reordering enums or reinitializing accounts.

Rollback to code lacking private team access controls, solution categories, moderation, saved STD sources, Hack, NOI-only self-evaluation, Strict IOI or the new permission catalog is refused when the corresponding data or explicit permission settings exist. Saved independent STD input/output settings also prevent rollback to a release that applies the target contest filenames to the STD. This prevents exposing private content, reversing moderation, losing categories or ignoring a saved denial. Repair the new release; stale SQL backups are never replayed over current data. The synchronization guard remains after community schema additions.

Rollback to the earlier small-upload implementation is also refused while 10 GiB team quotas or upload reservations exist. File metadata above the signed 32-bit range prevents rollback to code with integer file-size columns. Complete or cancel uploads and repair the current release rather than downgrading its storage handling.
