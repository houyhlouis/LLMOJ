# Feature upgrades and database changes

[简体中文](Community-Upgrade.zh-CN.md) | English | [Wiki home](Home.en.md)

LLMOJ's features beyond the original LibreOJ, such as teams, solutions, Fake moderation, hacks, Self Eval, Strict IOI, two-factor sign-in, durable judging and test data versions, need changes to the database as well as new code. The [upgrader](Upgrade.md) makes these changes for you. This page lists exactly what it may change, and how to apply the changes on an installation the upgrader doesn't support.

Updating only the web pages doesn't install these features, and turning on automatic schema synchronization (`LIBREOJ_SCHEMA_SYNC`) to migrate an unknown database isn't safe.

## What the upgrader may change

The upgrader accepts only these changes, each in its exact expected form. Anything else (unknown columns, changed types, nullability or defaults, removed or reordered values, or SQL that would delete data) makes it stop.

**Teams**
- Eight tables: `team`, `team_member`, `team_member_group`, `team_resource`, `team_assignment`, `team_file`, `team_invitation` and `team_file_upload` (which tracks space reserved by uploads in progress).
- `file.size` and `team_file.size` grow from `int` to `bigint`, without losing data.
- Every team's space, and the default for new teams (`team.quotaLimit`), becomes 10 GiB (10,737,418,240 bytes).

**Solutions:** `discussion.type varchar(20) NOT NULL DEFAULT 'Discussion'` with the index `IDX_discussion_type`. Existing discussions stay discussions. AI-written posts become solutions only when the AI job's record names both the post and the problem, and the post's author matches.

**Moderation:** `Fake` and then `Hacked` are added at the end of the fourteen existing `submission.status` values, which keep their order. A database that already has `Fake` is accepted.

**Hacks and Self Eval**
- Two hack tables, `hack` and `hack_problem`. A `hack_problem` table from the first hack release gets the nullable `standardContent` column (`longtext`) for the problem's reference code.
- Three Self Eval tables: `self_eval_set`, `self_eval` and `self_eval_quota`.

**Contests:** `contest.rule` grows from `varchar(8)` to `varchar(16)` without losing data, and the nullable `contest.ruleOptions longtext` is added for contest options. Only the rules `noi`, `ioi`, `acm` and `strictioi` are accepted.

**Permissions:** `ViewTeam`, `CreateTeam`, `ManageTeams`, `FakeSubmission`, `ViewHack`, `CreateHack`, `ManageHack`, `CreateSelfEval` and `ManageRegistrationReviews` are added at the end of the permission list; existing values, their order and existing grants are kept.

**Registration approval:** the `registration_application` table; see [Registration approval](Registration-Approval.md#upgrading).

**Two-factor sign-in:** the tables `user_two_factor` and `user_passkey`.

**Durable judging:** the tables `judge_job` and `judge_job_attempt`, and `judge_client.draining` for draining judge machines.

**Test data versions:** the tables `problem_data_version`, `deferred_file_deletion`, `submission_result_history` and `statistics_outbox`, and the nullable `submission.problemDataVersionId`.

Existing IDs, replies, accounts, problems and submitted code are never changed. When MariaDB rebuilds an index around a known change, the upgrader checks the index's definition first and never drops anything.

### Judge changes

Changes to the judge and its protocol are accepted when they only add things; see [Upgrading](Upgrade.md#what-it-supports). The first move from the original judge to the one with hacks and Self Eval is a special case: the exact files allowed are listed with their old and new hashes in `deploy/community-runtime-contract.json`, whose own hash is fixed in the upgrader. It's done automatically only for the `all` role. On a `web` installation the upgrader refuses it, because remote judges must be updated in step with the site; update them first, with the same version.

## Installations the upgrader doesn't support

For a custom installation, `deploy/migrate-community-features.mjs` applies the same checked changes to the database. It connects only to the database: it doesn't start the backend or any service, make backups or switch code. It needs an existing database; new installations get theirs from the installer.

1. Get the complete source of the version you're installing and build it:

   ```bash
   pnpm install --frozen-lockfile
   pnpm build:artifacts
   pnpm --filter @libreoj/judge run check-types
   pnpm --filter @libreoj/backend run build
   pnpm --filter @libreoj/frontend run build
   ```
2. Check the database (this changes nothing):

   ```bash
   node deploy/migrate-community-features.mjs \
     --root /path/to/complete-source \
     --config /path/to/instance/config/backend.yaml
   ```
3. Stop new work and wait for all judging, hacks, Self Eval runs, pretest preparation and AI jobs to finish, including on remote judges. Stop the backend and back up the database and configuration. Try the next step on a copy of the database first.
4. Apply the changes:

   ```bash
   node deploy/migrate-community-features.mjs \
     --root /path/to/complete-source \
     --config /path/to/instance/config/backend.yaml --apply --drained
   ```

   `--drained` is your confirmation that work has stopped. The database account needs permission to change tables; its password is never printed.
5. Start the new backend with `LIBREOJ_SCHEMA_SYNC=0`, publish the matching frontend and judge, and check the contest rules, permissions, teams, solutions, moderation, hacks and Self Eval before opening the site again.

`deploy/teams-migration.sql`, `deploy/solutions-migration.sql` and `deploy/fake-migration.sql` are kept for review. They cover only the first three features, not the later tables, statuses, permissions and contest columns, and running them by hand skips the backups and checks.

## Running it again and rolling back

Running the upgrader or the helper again is safe: once everything is applied, there's nothing left to do. If a database doesn't match, investigate rather than deleting tables, reordering values or recreating accounts.

Rolling back to code without one of these features is refused while data that depends on it exists, so that private team content isn't exposed, moderation isn't undone and saved denials aren't ignored. Specifically:
- data for teams, solutions, moderation, reference code, hacks, Self Eval, Strict IOI or the new permissions;
- reference code that uses its own input and output file names, which older code would replace with the contest's;
- 10 GiB team space or uploads in progress, which the older upload code can't handle; finish or cancel uploads first;
- files larger than 2 GiB, which don't fit the older file size columns.

Repair the new version instead. Old database backups are never loaded over current data, and the setting that stops the backend changing the database stays in place.
