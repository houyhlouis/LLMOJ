# Backend configuration

[简体中文](Backend-Configuration.zh-CN.md) | English | [Wiki home](Home.en.md) | [Configuration overview](Configuration.md)

This page describes every setting in the backend's configuration file, `backend.yaml`. It covers site-wide settings only; problems, contests and permissions are configured in the site itself.

## How the file is read

The backend reads the file named by `LIBREOJ_CONFIG_FILE`, normally `/opt/LLMOJ/config/backend.yaml`. It checks each setting's type and how related settings fit together, but **it doesn't fill in missing settings from the example**: the "Example" column below shows the value in [backend.yaml.example](https://github.com/houyhlouis/LLMOJ/blob/main/config/backend.yaml.example), not what you get by leaving a setting out. Keep the file complete.

- Every setting is required unless it's marked **optional**. Settings inside an optional section are required only when that section is present.
- Write numbers and `true`/`false` without quotes.
- Unknown settings aren't always rejected, so a misspelt setting may be silently ignored. Don't add settings this page doesn't list.
- The file is read when the backend starts. After changing it, restart the backend; browsers need a refresh to see changes to `preference`. Judges receive `judge.limit` when they connect.
- Everything under `preference`, except `preference.serverSideOnly`, is sent to browsers. Never put secrets there.

The file contains passwords and keys: never commit it or paste it into the wiki. The installer makes it readable only by root and the backend's group (mode `0640`). Changing a password here doesn't change it in MariaDB, Redis or MinIO: change both together.

### What the installer writes

The installer creates the file only if it doesn't exist. Compared with the example, it uses random passwords and keys for the database, Redis, MinIO, sessions and maintenance; points the public MinIO addresses at `/storage/` on the site's address; sets `metrics.allowedIps: [127.0.0.1]`; uses the site name you chose; and turns mail off with `services.mail.address: null`, `services.mail.transport: {jsonTransport: true}` and `preference.security.requireEmailVerification: false`. The example's SMTP address, `@example` and `REPLACE_WITH_*` values are placeholders.

## `server`: the backend process

| Setting | Example | Meaning |
| --- | --- | --- |
| `server.hostname` | `127.0.0.1` | IP address the backend listens on (an address, not a host name). Installations keep it on `127.0.0.1` behind Nginx. |
| `server.port` | `2002` | Port the backend listens on. Change Nginx and the local judge's `serverUrl` with it. |
| `server.trustProxy` | `["loopback"]` | List of proxies to trust, as addresses, networks or names such as `loopback`. It decides which client IP address and protocol the backend sees, which rate limiting depends on. List only proxies you actually use. |
| `server.clusters` | `null` | **Optional.** Number of backend worker processes: leave out or `null` for one process, `0` for one per CPU. More workers use more memory and metrics ports. This has nothing to do with judging capacity. |

## `metrics`: Prometheus metrics

**Optional:** leave the section out, or set it to `null`, to turn metrics off.

| Setting | Example | Meaning |
| --- | --- | --- |
| `metrics.hostname` | `127.0.0.1` | IP address to serve metrics on. Use `127.0.0.1` or a protected network. |
| `metrics.basePort` | `2020` | Port of the main process; worker processes use this port plus their worker number, so keep the range free. |
| `metrics.allowedIps` | `[]` | **Optional.** IP addresses allowed to read metrics, compared exactly with the connection's address (no ranges, no proxy headers). Empty or missing allows everyone. The installer writes `[127.0.0.1]`. |

## `services`: database, file storage, Redis and mail

### `services.database`

| Setting | Example | Meaning |
| --- | --- | --- |
| `services.database.type` | `mariadb` | `mariadb` or `mysql` |
| `services.database.host` | `127.0.0.1` | Database host name or IP address |
| `services.database.port` | `13306` | Database port |
| `services.database.username` | `libreoj` | Database user (not a site account) |
| `services.database.password` | `REPLACE_WITH_DATABASE_PASSWORD` | Database password, random in installations. Secret. |
| `services.database.database` | `libreoj` | Database name. Changing it doesn't move existing data. |

### `services.minio`

The backend signs upload and download links for MinIO. `default` is used for the backend's own access; the optional `forUserUpload`, `forUserDownload` and `forJudge` sections override it for links given to browsers and judges. Each has:

- `endpoint` (required in a section that's present): how the backend reaches MinIO, an address like `http://127.0.0.1:19000` with no path, user name, query or fragment;
- `urlEndpoint` (**optional**): the public address that replaces `endpoint` in the links it signs, which may include a path and must end in `/`, such as `https://oj.example.com/storage/`. If it's missing, the `default` one is used, and if that's missing too, links aren't rewritten.

| Setting | Example | Meaning |
| --- | --- | --- |
| `services.minio.default.endpoint` | `http://127.0.0.1:19000` | How the backend reaches MinIO |
| `services.minio.default.urlEndpoint` | `null` | **Optional.** Public address for links signed with `default` |
| `services.minio.forUserUpload.*` | endpoint `http://127.0.0.1:19000`, urlEndpoint `http://localhost/storage/` | **Optional section.** Links for uploads from browsers |
| `services.minio.forUserDownload.*` | as above | **Optional section.** Links for downloads to browsers |
| `services.minio.forJudge.*` | as above | **Optional section.** Links for judges' test data downloads |
| `services.minio.accessKey` | `REPLACE_WITH_MINIO_ACCESS_KEY` | MinIO user; installations use `libreoj-local`. Must match MinIO's own configuration. |
| `services.minio.secretKey` | `REPLACE_WITH_MINIO_SECRET_KEY` | MinIO password, random in installations. Secret; must match MinIO's own configuration. |
| `services.minio.bucket` | `libreoj-files` | Bucket for all files. Renaming it doesn't move existing files. |

**How uploads become files.** An upload link lets a browser write one object, `staging/<upload ID>`, for 10 minutes. Like any S3 upload link, it can be used again until then, so the backend never keeps that object as the file. When the upload is completed, the backend copies it to an object with a new ID that no link can write, checks the copy's size and records its SHA-256, registers the file, and deletes the staging object. Each upload becomes at most one file. If the uploaded object changes while it's copied, the upload is refused. Maintenance (`POST /api/runMaintainceTasks`, below) deletes what abandoned uploads left in staging once their links have expired, and copies that were never registered because a request failed halfway, an hour after they were made. Files from before this version keep their objects.

### `services.redis` and `services.mail`

| Setting | Example | Meaning |
| --- | --- | --- |
| `services.redis` | `redis://:REPLACE_WITH_REDIS_PASSWORD@127.0.0.1:16379/0` | Redis address, with its password and database number. Secret. Percent-encode special characters in the password. |
| `services.mail.address` | `no-reply@libreoj.test` | **Optional.** Sender address for mail, which your mail server must accept. Installations write `null`. |
| `services.mail.transport` | `smtp://username:password@smtp.libreoj.test:25` | How to send mail: an SMTP URL or an options object, passed to [Nodemailer](https://nodemailer.com/smtp/) unchanged (for example `host`, `port`, `secure`, `auth.user`, `auth.pass`, `tls`, `pool`). Installations write `{jsonTransport: true}`, which doesn't send anything. Secret if it contains a password. |

LLMOJ doesn't check that mail can actually be sent. Send yourself a test message before turning on email verification.

## `security`: sessions, CAPTCHA, proof of work and rate limits

| Setting | Example | Meaning |
| --- | --- | --- |
| `security.sessionSecret` | `REPLACE_WITH_SESSION_SECRET` | Key that signs sign-in sessions, random in installations. Secret. Changing it signs everyone out. |
| `security.sessionIdleTimeoutDays` | `30` | **Optional.** A session unused for this many days ends. `0` means never; 30 if left out. |
| `security.sessionMaxAgeDays` | `90` | **Optional.** A session ends this many days after signing in, even if it's used. `0` means never; 90 if left out. |
| `security.adminSessionIdleTimeoutDays` | `3` | **Optional.** A site administrator's session ends after this many days without use, when that's sooner than `sessionIdleTimeoutDays`. `0` adds no limit of its own; 3 if left out. |
| `security.adminSessionMaxAgeDays` | `30` | **Optional.** A site administrator's session ends this many days after signing in, when that's sooner than `sessionMaxAgeDays`. `0` adds no limit of its own; 30 if left out. |
| `security.sessionCookie` | `true` | **Optional.** Pages on the API's own origin keep their sign-in session in an HttpOnly cookie, which page scripts can't read; over HTTPS it's also marked `Secure`. With `false`, signing in gives pages the session token, as before; cookie sessions that already exist keep working until they end. Pages on another origin and API clients always send the token in the `Authorization` header. `true` if left out. |
| `security.maintainceKey` | `REPLACE_WITH_MAINTENANCE_KEY` | Key for the `maintaince-key` header of `POST /api/runMaintainceTasks` (the misspelling is intentional). Secret. |
| `security.proofOfWork.difficulty` | `4` | Proof-of-work difficulty for protected actions, 1 to 8. Higher values make browsers work longer. It can't be turned off. |
| `security.proofOfWork.expensiveActionDifficulty` | `5` | Proof-of-work difficulty for expensive actions such as submitting, 1 to 8 |
| `security.crossOrigin.enabled` | `false` | Serve the xdomain cross-origin proxy page. It doesn't turn on CORS for the API. |
| `security.crossOrigin.whiteList` | `[]` | Frontend addresses allowed to use the xdomain proxy, such as `https://oj.example.com` |
| `security.rateLimit.maxRequests` | `200` | Requests allowed per client IP address in each period; more get HTTP 429 |
| `security.rateLimit.durationSeconds` | `10` | Length of the period in seconds. Counters are kept in memory and aren't shared between servers. |

`security.rateLimit` is **optional**: leave it out to turn the general rate limit off. It counts requests by the client IP address the backend sees, so set `server.trustProxy` correctly, or many users may share one address's limit. Some limits are fixed in the code: proof-of-work challenges expire after five minutes, and each IP address or user can get 20 challenges per ten seconds.

### CAPTCHA

`security.captcha` must be present. It has two **optional** providers, `turnstile` and `tencentCaptcha`; set both to `null` to turn CAPTCHA off. Proof of work works independently of it.

| Setting | Meaning |
| --- | --- |
| `security.captcha.turnstile.siteKey` | Cloudflare Turnstile site key (public: it's sent to browsers) |
| `security.captcha.turnstile.secretKey` | Turnstile secret key. Secret. |
| `security.captcha.tencentCaptcha.appId` | Tencent CAPTCHA app ID, a positive number |
| `security.captcha.tencentCaptcha.appSecretKey` | Tencent CAPTCHA app key: 1 to 32 printable ASCII characters without spaces. Secret. |
| `security.captcha.tencentCaptcha.secretId` | Tencent Cloud SecretId. Secret. |
| `security.captcha.tencentCaptcha.secretKey` | Tencent Cloud SecretKey. Secret. |

## `preference`: site behavior and display

### General

| Setting | Example | Meaning |
| --- | --- | --- |
| `preference.siteName` | `LLMOJ` | Site name in pages, the footer, mail and event reports |
| `preference.copyrightNotice` | `LLMOJ` | Extra line under "*site name* Powered by LLMOJ" in the footer. Empty, `LLMOJ` and `LibreOJ Open Source Project` add nothing. |

### `preference.security`

| Setting | Example | Meaning |
| --- | --- | --- |
| `preference.security.registrationMode` | `open` | **Optional.** `open`, `approval` or `closed` (`open` if left out). A mode saved in **Site management** takes precedence. See [Registration approval](Registration-Approval.md). |
| `preference.security.requireEmailVerification` | `true` | Send a code by email to register, to change an email address and to reset a password. Make sure mail works first. With `false` no codes are sent: registering and changing an address need none, and forgotten passwords can't be reset by email (a user manager can set a new one). |
| `preference.security.allowUserChangeUsername` | `true` | Users may change their own user name (they also need permission to edit their own profile) |
| `preference.security.allowEveryoneCreateProblem` | `true` | Signed-in users may create problems unless a permission rule says otherwise |
| `preference.security.allowNonPrivilegedUserEditPublicProblem` | `true` | A problem's owner, or users with write access to it, may still edit it once it's public |
| `preference.security.allowOwnerManageProblemPermission` | `false` | A problem's owner may change who can access it (for public problems, only if the previous setting is on) |
| `preference.security.allowOwnerDeleteProblem` | `true` | A problem's owner may delete it (for public problems, only if editing public problems is allowed) |
| `preference.security.discussionDefaultPublic` | `true` | New discussions are public by default |
| `preference.security.discussionReplyDefaultPublic` | `true` | New replies are public by default |
| `preference.security.allowEveryoneCreateDiscussion` | `true` | Signed-in users may start discussions unless a permission rule says otherwise |

The "allow" settings are defaults: explicit permission rules on the **Permissions** page still take precedence. Don't set `captchaEnabled` or `turnstileSiteKey` here: the backend fills them in from `security.captcha`.

**Email verification codes.** A code is for one purpose (registering, changing an address or resetting a password), for the address it was sent to, in any letter case, and, to change an address or reset a password, for the account that asked for it. It works once: of two requests with the same code, even at the same moment, only one succeeds. If the change it allowed then fails, which is rare, request a new code. A code expires after 15 minutes, and a newer code for the same purpose and address replaces it; an address gets at most one code a minute. A code stops working after 5 wrong answers, and each purpose accepts at most 20 wrong answers an hour for an address, whatever codes they were for. The page doesn't say which of these happened; it asks for a new code. Wrong codes for password resets and address changes are recorded in the user's audit log, without the code. Codes sent before an upgrade to this version stop working.

### `preference.pagination`

Items per page. Each must be at least 1, and where a `queryLimit` is named, no more than it.

| Setting | Example | Page | At most |
| --- | --- | --- | --- |
| `preference.pagination.homepageUserList` | `10` | Users on the home page | |
| `preference.pagination.homepageProblemList` | `10` | Problems on the home page | |
| `preference.pagination.problemSet` | `50` | Problem set | `queryLimit.problemSet` |
| `preference.pagination.searchProblemsPreview` | `7` | Problem search suggestions | `queryLimit.problemSet` |
| `preference.pagination.submissions` | `10` | Submissions | `queryLimit.submissions` |
| `preference.pagination.submissionStatistics` | `10` | Submission statistics | `queryLimit.submissionStatistics` |
| `preference.pagination.userList` | `30` | Users | `queryLimit.userList` |
| `preference.pagination.userAuditLogs` | `10` | Audit log | `queryLimit.userAuditLogs` |
| `preference.pagination.discussions` | `10` | Discussions | `queryLimit.discussions` |
| `preference.pagination.searchDiscussionsPreview` | `7` | Discussion search suggestions | `queryLimit.discussions` |
| `preference.pagination.discussionReplies` | `40` | Replies on a full page | `queryLimit.discussionReplies` |
| `preference.pagination.discussionRepliesHead` | `20` | Replies shown before "show more" | less than `discussionReplies` |
| `preference.pagination.discussionRepliesMore` | `20` | Replies loaded by "show more" | `queryLimit.discussionReplies` |

### `preference.misc`

| Setting | Example | Meaning |
| --- | --- | --- |
| `preference.misc.appLogo` | `''` | Logo address; empty for the default logo |
| `preference.misc.appLogoForTheme` | `{"pure": "original", "far": "inverted"}` | Logo for each theme: `original` (the normal logo), `inverted` (the normal logo inverted), `default` (the default logo) or an image address. Themes not listed use `original`. |
| `preference.misc.googleAnalyticsId` | `null` | **Optional.** Google Analytics ID; empty to turn it off. Browsers then contact Google. |
| `preference.misc.plausibleApiEndpoint` | `null` | **Optional.** Plausible Analytics address; empty to turn it off |
| `preference.misc.gravatarCdn` | `https://gravatar.com` | Avatar service address (`avatar/` is added to it) |
| `preference.misc.redirectLegacyUrls` | `false` | Redirect old LibreOJ page addresses to the current ones |
| `preference.misc.legacyContestsEntryUrl` | `null` | **Optional.** Kept for compatibility; currently unused |
| `preference.misc.homepageUserListOnMainView` | `true` | Show the user list in the main column of the home page |
| `preference.misc.sortUserByRating` | `false` | Sort users by rating (it doesn't calculate ratings) |
| `preference.misc.renderMarkdownInUserBio` | `false` | Show users' bios as Markdown (never as raw HTML) |
| `preference.misc.discussionReactionEmojis` | `["👍","👎","😄","😕","❤️","🤔","🤣","🌿","🍋","🕊️"]` | Reaction emoji offered on discussions: at least one, no duplicates, each a single emoji of at most 28 bytes |
| `preference.misc.discussionReactionAllowCustomEmojis` | `true` | Users may react with other emoji too, except those blocked below |

### `preference.serverSideOnly`

Never sent to browsers.

| Setting | Example | Meaning |
| --- | --- | --- |
| `preference.serverSideOnly.discussionReactionCustomEmojisBlacklist` | `/(\uD83C[\uDDE6-\uDDFF]){2}/` | Emoji users may not react with: one emoji, a `/regular expression/`, or a flat list of them (`[]` blocks nothing). The example blocks flags. Regular expression flags aren't supported. |
| `preference.serverSideOnly.dynamicTaskPriority` | `true` | Order the judge queue by submission, problem and user; `false` judges everything in order of arrival |

## `resourceLimit`: problem and file limits

| Setting | Example | Meaning |
| --- | --- | --- |
| `resourceLimit.problemTestdataFiles` | `2005` | Test data files per problem |
| `resourceLimit.problemTestdataSize` | `8589934592` (8 GiB) | Total test data size per problem, in bytes |
| `resourceLimit.problemAdditionalFileFiles` | `40` | Additional files per problem |
| `resourceLimit.problemAdditionalFileSize` | `134217728` (128 MiB) | Total additional file size per problem, in bytes |
| `resourceLimit.problemSamplesToRun` | `10` | Samples run before the tests of a submission; `0` runs none |
| `resourceLimit.problemTestcases` | `1000` | Tests per problem (at least 1) |
| `resourceLimit.problemTimeLimit` | `2000` | Highest time limit a problem may have, in milliseconds |
| `resourceLimit.problemMemoryLimit` | `512` | Highest memory limit a problem may have, in MiB |
| `resourceLimit.submissionFileSize` | `10485760` (10 MiB) | Largest submitted file, in bytes. Nginx, a proxy in front, or the problem type may allow less. |

`0` is allowed where it makes sense, and means "none", not "unlimited". Users with permission to ignore limits may exceed some of these. AI imports and generation have limits of their own, which these settings don't change.

## `queryLimit`: largest page the backend returns

These cap what a single request may ask for; the page sizes in `preference.pagination` must not exceed them. Each is at least 1.

| Setting | Example | Applies to |
| --- | --- | --- |
| `queryLimit.problemSet` | `100` | Problem set and problem search |
| `queryLimit.submissions` | `10` | Submissions |
| `queryLimit.submissionStatistics` | `10` | Submission statistics |
| `queryLimit.searchUser` | `10` | User search |
| `queryLimit.searchGroup` | `10` | Group search |
| `queryLimit.userList` | `100` | Users |
| `queryLimit.userAuditLogs` | `20` | Audit log |
| `queryLimit.discussions` | `20` | Discussions and discussion search |
| `queryLimit.discussionReplies` | `50` | Discussion replies |

## `judge.limit`: limits sent to judges

| Setting | Example | Meaning |
| --- | --- | --- |
| `judge.limit.compilerMessage` | `524288` (512 KiB) | Compiler output kept, in bytes |
| `judge.limit.outputSize` | `104857600` (100 MiB) | Largest output a program may write, in bytes. Each judge's `binaryCacheMaxSize` must be at least this. |
| `judge.limit.dataDisplay` | `128` | Bytes of input and output shown in results |
| `judge.limit.dataDisplayForSubmitAnswer` | `128` | Bytes of a submitted answer file shown in results (for answer-only problems) |
| `judge.limit.stderrDisplay` | `5120` (5 KiB) | Bytes of a program's standard error shown in results |

## `eventReport`: Telegram notifications

The section must be present; leave `telegramBotToken` empty to turn notifications off.

| Setting | Example | Meaning |
| --- | --- | --- |
| `eventReport.telegramBotToken` | `null` | **Optional.** Telegram bot token. Secret. With a token, the backend sends site events to Telegram. |
| `eventReport.telegramApiRoot` | `null` | **Optional.** Address of the Telegram API, if not the default |
| `eventReport.sentTo` | `@example` | **Optional.** Chat ID, or a channel the bot may post to |
| `eventReport.proxyUrl` | `null` | **Optional.** Proxy for Telegram only. Secret if it contains a password. |

## `vendor`: IP address locations

The section must be present. `vendor.ip2region` is **optional**: leave it out to use the location data built into the library.

| Setting | Meaning |
| --- | --- |
| `vendor.ip2region.ipv4db` | Path of your own ip2region IPv4 database, readable by the backend |
| `vendor.ip2region.ipv6db` | Path of your own ip2region IPv6 database, readable by the backend |

## What isn't in this file

- The registration mode saved in **Site management**, which overrides `preference.security.registrationMode` at once, without a restart.
- Permissions and access rules for users, groups, problems and discussions, including `ManageRegistrationReviews` and the AI permissions (`ManageAiConfiguration`, `UseAi`, `GenerateTestdata`, `ImportProblem`). They're stored in the database, apply without a restart, and are set on the **Permissions** page; see [Registration approval](Registration-Approval.md) and [AI](AI.md).
- Each user's AI provider keys; see [AI](AI.md).
- Judging capacity; see [Judge configuration](Judge-Configuration.md).

There are no settings for turning registration on or off other than the registration mode, allowed email domains, or rate limits per endpoint; adding such keys does nothing.

## Changing the file

1. Back up the file in use and edit it; never replace it with the example, which would lose your passwords and keys.
2. Check that page sizes don't exceed their `queryLimit`, and that ports, public storage addresses, mail and CAPTCHA settings fit together.
3. Restart the backend. Change listening addresses, proxies and passwords together with the services they affect. Refresh browsers, and check that judges reconnect if you changed `judge.limit`.
4. Check that you can sign in, that the change works, and that the log shows no errors. A file that passes the backend's checks doesn't prove that mail, Telegram, the database or storage can be reached.

Sources: [config.schema.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/config/config.schema.ts), [config-relation.decorator.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/config/config-relation.decorator.ts), [backend.yaml.example](https://github.com/houyhlouis/LLMOJ/blob/main/config/backend.yaml.example), [configure-local.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-local.py).
