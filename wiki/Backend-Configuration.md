# Complete backend configuration reference

[中文](Backend-Configuration.zh-CN.md) · [Wiki home](Home.en.md)

Audited against `43a88bdd62fbf200889b36932fa921439a293190`. This page covers all 110 leaf fields of `AppConfig`, its structural objects and open dictionaries. It documents server-wide `backend.yaml`, not every problem or contest business setting.

## File, defaults and activation

The backend reads the file selected by `LIBREOJ_CONFIG_FILE`, normally `/opt/LibreOJ/config/backend.yaml` after one-click installation. [ConfigService](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/config/config.service.ts) loads YAML, transforms and validates it, and checks cross-field relationships. **It does not merge the example or fill general defaults.** “Example value” below therefore does not mean “the default obtained by omitting this field.” Preserve a complete configuration except where optional or derived behavior is documented.

All fields are read at process startup; there is no file hot reload. Restart the backend through your operational procedure after changes. `preference`, except `serverSideOnly`, is returned to browsers through `auth/getSessionInfo`; refresh/reinitialize the browser after restarting. Runtime preferences generally do not require a frontend rebuild. `judge.limit` is sent when a judge connects; verify reconnection before relying on changed values. Backend `server.clusters` is not judge capacity.

The schema does not use `IsDefined` for every object and configuration validation does not strip unknown keys through a whitelist. A typo not immediately rejected is not evidence that it works; missing objects may fail when a consumer initializes. Do not add undocumented keys or place secrets in public `preference` data.

Sources: [schema](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/config/config.schema.ts), [relationship validation](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/config/config-relation.decorator.ts), [source example](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/config/backend.yaml.example), [installer generator](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/configure-local.py).

## Example values differ from first-install values

The installer creates configuration only when absent and preserves existing files on reruns. On first installation it replaces database, Redis, MinIO, session and maintenance secrets; sets external MinIO URLs to the site origin plus `/storage/`; uses `metrics.allowedIps: [127.0.0.1]`; takes the site name from `--site-name`; and sets `services.mail.address: null`, `services.mail.transport: {jsonTransport: true}` and `preference.security.requireEmailVerification: false`. The sample SMTP URL, `@example` and `REPLACE_WITH_*` are not working credentials.

`backend.yaml` contains secrets: never commit it or upload it to the Wiki. The installer gives it root ownership and backend-group read access (0640). Coordinate database/Redis/MinIO password changes with those services; this file does not rotate their credentials.

“Required” below means an item that a complete running configuration should supply. “Optional” permits omission/null, with consumer-specific behavior described in the notes. Required children of optional objects apply when that object is enabled. Use YAML numbers and `true/false`, not quoted numeric/boolean strings.

## `server` — Listener and backend processes

| Object | Rule |
| --- | --- |
| `server` | Required structural object; children are listed below. |

| Full field | Type / requirement | Source example (not default) | Purpose, constraints and fallback |
| --- | --- | --- | --- |
| `server.hostname` | `string`; required | `127.0.0.1` | Backend bind IP, not a hostname. The local installer binds loopback; Nginx supplies the public listener. |
| `server.port` | `number`; required | `2002` | Backend listener, integer 1–65535. Coordinate changes with the Nginx upstream and local judge serverUrl. |
| `server.trustProxy` | string array; required | `["loopback"]` | Array of trusted Express proxy addresses, networks or predefined names such as loopback. Affects client IP/protocol and IP rate limits. Trust only real proxies. The TypeScript annotation says string, but validation and usage require an array. |
| `server.clusters` | `number`; optional | `null` | Optional nonnegative integer: omitted/null disables clustering; 0 enables it with os.cpus().length workers; a positive value selects the worker count. This is not judge capacity; more workers consume memory and metrics ports. |

## `metrics` — Metrics

| Object | Rule |
| --- | --- |
| `metrics` | Omit/null to disable the metrics listener. |

| Full field | Type / requirement | Source example (not default) | Purpose, constraints and fallback |
| --- | --- | --- | --- |
| `metrics.hostname` | `string`; required when parent enabled | `127.0.0.1` | Required bind IP when metrics is enabled; use loopback or a protected monitoring network. |
| `metrics.basePort` | `number`; required when parent enabled | `2020` | Integer 1–65535. The primary uses this port and workers use basePort + worker.id. Reserve the range; base-port validation does not validate the final worker port. |
| `metrics.allowedIps` | `string[]`; optional | `[]` | Optional IP array. Missing/null/[] imposes no source restriction. Nonempty entries exactly match socket.remoteAddress, not proxy headers; CIDR is not supported. Installer value: [127.0.0.1]. |

## `services` — Database, object storage, Redis and mail

| Object | Rule |
| --- | --- |
| `services` | Required structural object; children are listed below. |
| `services.database` | Required structural object; children are listed below. |
| `services.minio` | Required structural object; children are listed below. |
| `services.minio.default` | Required structural object; children are listed below. |
| `services.minio.forUserUpload` | Optional/null: fall back to default. |
| `services.minio.forUserDownload` | Optional/null: fall back to default. |
| `services.minio.forJudge` | Optional/null: fall back to default. |
| `services.mail` | Required structural object; children are listed below. |

| Full field | Type / requirement | Source example (not default) | Purpose, constraints and fallback |
| --- | --- | --- | --- |
| `services.database.type` | `"mysql" \| "mariadb"`; required | `mariadb` | Database driver: mysql or mariadb only. |
| `services.database.host` | `string`; required | `127.0.0.1` | Database host string: hostname or IP. |
| `services.database.port` | `number`; required | `13306` | Database port, integer 1–65535. |
| `services.database.username` | `string`; required | `libreoj` | Database login, distinct from an OJ administrator account. |
| `services.database.password` | `string`; required | `REPLACE_WITH_DATABASE_PASSWORD` | Sensitive: database password. The installer generates it; never use the template placeholder. |
| `services.database.database` | `string`; required | `libreoj` | Database name; changing it does not migrate existing data. |
| `services.minio.default.endpoint` | `string`; required | `http://127.0.0.1:19000` | Default server-side object-storage connection. HTTP(S) origin with root path / only; no credentials, query or fragment. Required. |
| `services.minio.default.urlEndpoint` | `string`; optional | `null` | Default server-side object-storage connection URL replacement prefix; paths such as /storage/ are allowed and must end in /. No query/fragment. Missing/null means no rewrite. |
| `services.minio.forUserUpload.endpoint` | `string`; required when parent enabled | `http://127.0.0.1:19000` | Browser-upload signing connection. HTTP(S) origin with root path / only; no credentials, query or fragment. Omitting the entire override object falls back to default; supply endpoint when the object exists. |
| `services.minio.forUserUpload.urlEndpoint` | `string`; optional | `http://localhost/storage/` | Browser-upload signing connection URL replacement prefix; paths such as /storage/ are allowed and must end in /. No query/fragment. Missing/null falls back to default.urlEndpoint; no default means no rewrite. |
| `services.minio.forUserDownload.endpoint` | `string`; required when parent enabled | `http://127.0.0.1:19000` | Browser-download signing connection. HTTP(S) origin with root path / only; no credentials, query or fragment. Omitting the entire override object falls back to default; supply endpoint when the object exists. |
| `services.minio.forUserDownload.urlEndpoint` | `string`; optional | `http://localhost/storage/` | Browser-download signing connection URL replacement prefix; paths such as /storage/ are allowed and must end in /. No query/fragment. Missing/null falls back to default.urlEndpoint; no default means no rewrite. |
| `services.minio.forJudge.endpoint` | `string`; required when parent enabled | `http://127.0.0.1:19000` | Judge-download signing connection. HTTP(S) origin with root path / only; no credentials, query or fragment. Omitting the entire override object falls back to default; supply endpoint when the object exists. |
| `services.minio.forJudge.urlEndpoint` | `string`; optional | `http://localhost/storage/` | Judge-download signing connection URL replacement prefix; paths such as /storage/ are allowed and must end in /. No query/fragment. Missing/null falls back to default.urlEndpoint; no default means no rewrite. |
| `services.minio.accessKey` | `string`; required | `REPLACE_WITH_MINIO_ACCESS_KEY` | Credential: MinIO access identifier. The installer uses libreoj-local; it must match the object store. |
| `services.minio.secretKey` | `string`; required | `REPLACE_WITH_MINIO_SECRET_KEY` | Sensitive: MinIO secret, randomly generated by the installer. Changing only this side breaks authentication. |
| `services.minio.bucket` | `string`; required | `libreoj-files` | Bucket for files. Application permissions and signed access still apply; renaming does not move existing objects. |
| `services.redis` | `string`; required | `redis://:REPLACE_WITH_REDIS_PASSWORD@127.0.0.1:16379/0` | Sensitive ioredis connection string, possibly including a password and database number. Installer uses local port 16379/database 0 with a random password. |
| `services.mail.address` | `string`; optional | `no-reply@libreoj.test` | Optional valid sender email. Configure it for real mail delivery using an identity accepted by your SMTP service. Installer value: null. |
| `services.mail.transport` | URL string/object; required | `smtp://username:password@smtp.libreoj.test:25` | URL or options object passed directly to Nodemailer createTransport, without per-option schema validation. Sensitive if it includes password/OAuth credentials. Installer uses {jsonTransport: true}, which creates messages without delivery. See the open-dictionary notes below. |

## `security` — Sessions, CAPTCHA, PoW and rate limiting

| Object | Rule |
| --- | --- |
| `security` | Required structural object; children are listed below. |
| `security.captcha` | Keep the object; null both providers to disable third-party CAPTCHA, independently of PoW. |
| `security.captcha.turnstile` | Optional; null disables this provider. |
| `security.captcha.tencentCaptcha` | Optional; null disables this provider. |
| `security.proofOfWork` | Required structural object; children are listed below. |
| `security.crossOrigin` | Required structural object; children are listed below. |
| `security.rateLimit` | Omit/null to disable global IP limiting, not other fixed limits. |

| Full field | Type / requirement | Source example (not default) | Purpose, constraints and fallback |
| --- | --- | --- | --- |
| `security.sessionSecret` | `string`; required | `REPLACE_WITH_SESSION_SECRET` | Sensitive JWT signing/verification secret, randomly generated at installation. Rotating it invalidates existing login tokens. |
| `security.maintainceKey` | `string`; required | `REPLACE_WITH_MAINTENANCE_KEY` | Sensitive key for the maintaince-key header of POST /api/runMaintainceTasks. Keep the source spelling maintaince; this is not an administrator password. |
| `security.captcha.turnstile.siteKey` | `string`; required when parent enabled | not set | Required nonempty public site key when Turnstile is enabled; sent to browsers. |
| `security.captcha.turnstile.secretKey` | `string`; required when parent enabled | not set | Required nonempty private Turnstile secret; used by the server for verification with Cloudflare. |
| `security.captcha.tencentCaptcha.appSecretKey` | `string`; required when parent enabled | not set | Sensitive Tencent CAPTCHA application secret: 1–32 visible non-whitespace ASCII characters (0x21–0x7e). |
| `security.captcha.tencentCaptcha.appId` | `number`; required when parent enabled | not set | Tencent CAPTCHA application ID, integer ≥1; distinct from cloud SecretId. |
| `security.captcha.tencentCaptcha.secretId` | `string`; required when parent enabled | not set | Credential: nonempty Tencent Cloud SecretId string. |
| `security.captcha.tencentCaptcha.secretKey` | `string`; required when parent enabled | not set | Sensitive nonempty Tencent Cloud SecretKey string. |
| `security.proofOfWork.difficulty` | `number`; required | `4` | Proof-of-work difficulty for ordinary protected actions, integer 1–8. Not an enable switch: 0 is invalid. Higher values require more browser work. |
| `security.proofOfWork.expensiveActionDifficulty` | `number`; required | `5` | PoW difficulty for expensive actions, currently submission and Tencent CAPTCHA acquisition; integer 1–8. Independent of third-party CAPTCHA and global rate limiting. |
| `security.crossOrigin.enabled` | `boolean`; required | `false` | Enables the xdomain cross-origin proxy page/script. It is not a general Access-Control-Allow-Origin switch and does not enable CORS on all APIs. |
| `security.crossOrigin.whiteList` | `string[]`; required | `[]` | Array of frontend origins allowed by xdomain, such as https://oj.example.com. Use only controlled origins; consulted when enabled=true. |
| `security.rateLimit.maxRequests` | `number`; required when parent enabled | `200` | Request-point allowance per client IP per window. Schema checks integer only; use a positive value operationally. Exceeded limits return HTTP 429. Omit/null the entire rateLimit object to disable this layer. |
| `security.rateLimit.durationSeconds` | `number`; required when parent enabled | `10` | Rate-limit window in seconds. Schema checks integer only; use a positive value. Counters are in memory, coordinated by the primary in Node cluster mode, not shared across independent hosts. |

## `preference` — Public and server-only preferences

| Object | Rule |
| --- | --- |
| `preference` | Public except serverSideOnly; do not store secrets. |
| `preference.security` | Required structural object; children are listed below. |
| `preference.pagination` | Required structural object; children are listed below. |
| `preference.misc` | Required structural object; children are listed below. |
| `preference.serverSideOnly` | Required structure; not sent to browsers. |

| Full field | Type / requirement | Source example (not default) | Purpose, constraints and fallback |
| --- | --- | --- | --- |
| `preference.siteName` | `string`; required | `LLMOJ` | Public site name used by pages, mail and event reports; installer takes --site-name (default LLMOJ). |
| `preference.copyrightNotice` | `string`; required | `LibreOJ Open Source Project` | Public footer attribution/copyright text; this display setting does not change the project license. |
| `preference.security.captchaEnabled` | `boolean`; derived; do not set | derived | Derived public field: actual output is based on whether security.captcha configures a provider. A manually supplied value is overwritten. |
| `preference.security.turnstileSiteKey` | `string`; derived; do not set | derived | Derived public field copied from security.captcha.turnstile.siteKey. Never place a secretKey here. |
| `preference.security.requireEmailVerification` | `boolean`; required | `true` | Whether registration verifies an emailed code. Template true, installer false. Configure and verify mail delivery before enabling. False does not remove mail requirements from reset-password/change-email flows and does not disable registration. |
| `preference.security.allowUserChangeUsername` | `boolean`; required | `true` | Allows ordinary users to change their own username, still subject to EditOwnProfile; ManageUser provides the administrative path. |
| `preference.security.allowEveryoneCreateProblem` | `boolean`; required | `true` | Default fallback for logged-in users creating problems; it does not permit guests. Explicit CreateProblem allow/deny rules still participate. |
| `preference.security.allowNonPrivilegedUserEditPublicProblem` | `boolean`; required | `true` | Allows an otherwise authorized owner or Write-ACL user to edit a public problem. It does not give every user write access; global edit permissions still apply. |
| `preference.security.allowOwnerManageProblemPermission` | `boolean`; required | `false` | Fallback allowing an owner to manage that problem ACL; public problems also depend on allowNonPrivilegedUserEditPublicProblem. It does not grant site /permissions administration. |
| `preference.security.allowOwnerDeleteProblem` | `boolean`; required | `true` | Fallback allowing owners to delete their own problems; public-problem editing policy and explicit deletion permissions also apply. |
| `preference.security.discussionDefaultPublic` | `boolean`; required | `true` | Default public flag for new discussions; does not rewrite existing discussions or bypass object access control. |
| `preference.security.discussionReplyDefaultPublic` | `boolean`; required | `true` | Default public flag for new discussion replies; existing replies are unchanged. |
| `preference.security.allowEveryoneCreateDiscussion` | `boolean`; required | `true` | Default fallback for logged-in users creating discussions; explicit CreateDiscussion and related-object permissions still apply. |
| `preference.pagination.homepageUserList` | `number`; required | `10` | Public homepage user-list size, integer ≥1. No additional cross-field relation is declared. |
| `preference.pagination.homepageProblemList` | `number`; required | `10` | Public homepage problem-list size, integer ≥1. No additional cross-field relation is declared. |
| `preference.pagination.problemSet` | `number`; required | `50` | Public problem-set page size, integer ≥1. Must not exceed queryLimit.problemSet. |
| `preference.pagination.searchProblemsPreview` | `number`; required | `7` | Public problem-search preview size, integer ≥1. Must not exceed queryLimit.problemSet. |
| `preference.pagination.submissions` | `number`; required | `10` | Public submission-list page size, integer ≥1. Must not exceed queryLimit.submissions. |
| `preference.pagination.submissionStatistics` | `number`; required | `10` | Public submission-statistics page size, integer ≥1. Must not exceed queryLimit.submissionStatistics. |
| `preference.pagination.userList` | `number`; required | `30` | Public user-list page size, integer ≥1. Must not exceed queryLimit.userList. |
| `preference.pagination.userAuditLogs` | `number`; required | `10` | Public user-audit page size, integer ≥1. Must not exceed queryLimit.userAuditLogs. |
| `preference.pagination.discussions` | `number`; required | `10` | Public discussion-list page size, integer ≥1. Must not exceed queryLimit.discussions. |
| `preference.pagination.searchDiscussionsPreview` | `number`; required | `7` | Public discussion-search preview size, integer ≥1. Must not exceed queryLimit.discussions. |
| `preference.pagination.discussionReplies` | `number`; required | `40` | Public full discussion-reply page size, integer ≥1. Must not exceed queryLimit.discussionReplies. |
| `preference.pagination.discussionRepliesHead` | `number`; required | `20` | Public reply count initially shown before expansion, integer ≥1. Must be less than preference.pagination.discussionReplies. |
| `preference.pagination.discussionRepliesMore` | `number`; required | `20` | Public reply count requested on expansion, integer ≥1. Must not exceed queryLimit.discussionReplies. |
| `preference.misc.appLogo` | `string`; required | `''` | Logo URL/path string; empty uses the frontend default presentation. Frontend window.appLogo can override it, and theme mappings may select another image. |
| `preference.misc.appLogoForTheme` | `Record<string, string>`; required | `{"pure":"original","far":"inverted"}` | Open dictionary from theme names to strings, e.g. pure: original and far: inverted. original selects the normal logo, inverted applies inversion, another string is an image path, and default requests the default logo. Missing theme entries fall back to original. |
| `preference.misc.googleAnalyticsId` | `string`; optional | `null` | Optional Google Analytics identifier; null/empty disables loading. Public; enabling causes browser requests to analytics services. |
| `preference.misc.plausibleApiEndpoint` | `string`; optional | `null` | Optional Plausible API URL, validated as a URL; null disables loading. |
| `preference.misc.gravatarCdn` | `string`; required | `https://gravatar.com` | Avatar-service base URL string; the frontend appends avatar/. Can be overridden by window.gravatarCdn. |
| `preference.misc.redirectLegacyUrls` | `boolean`; required | `false` | Enables legacy redirects already defined in the frontend; it does not import old data or create arbitrary redirect rules. |
| `preference.misc.legacyContestsEntryUrl` | string/null; optional | `null` | Retained compatibility field, optional string/null. The TypeScript annotation says boolean but runtime validation is IsString. No page consumer was found in this version; do not rely on it to display a legacy-contest entry. |
| `preference.misc.homepageUserListOnMainView` | `boolean`; required | `true` | Controls whether the homepage user list is placed in the main content area. |
| `preference.misc.sortUserByRating` | `boolean`; required | `false` | Preference for sorting users by rating; does not compute or update ratings. |
| `preference.misc.renderMarkdownInUserBio` | `boolean`; required | `false` | Whether user bios are rendered as Markdown; does not grant arbitrary HTML rendering. |
| `preference.misc.discussionReactionEmojis` | `string[]`; required | `["👍","👎","😄","😕","❤️","🤔","🤣","🌿","🍋","🕊️"]` | Nonempty, unique array of default reactions; each is one valid emoji with UTF-8 length at most 28 bytes. |
| `preference.misc.discussionReactionAllowCustomEmojis` | `boolean`; required | `true` | Allows reactions beyond the default list, still subject to emoji validation and the server-only blacklist. |
| `preference.serverSideOnly.discussionReactionCustomEmojisBlacklist` | `string \| unknown[]`; required | `/(\uD83C[\uDDE6-\uDDFF]){2}/` | Server-only: one emoji, a /regular expression/ string, or a flat array of these; [] means no blacklist. The template blocks flags. Although schema validation accepts nested arrays recursively, the consumer flattens once; use a flat array. Regex flags are not supported and the pattern must compile. |
| `preference.serverSideOnly.dynamicTaskPriority` | `boolean`; required | `true` | Server-only dynamic queue priority based on submission/problem/user context; false uses uniform priority. It does not set concurrency or rate limits. |

## `resourceLimit` — Problem and file resource limits

| Object | Rule |
| --- | --- |
| `resourceLimit` | Required structural object; children are listed below. |

| Full field | Type / requirement | Source example (not default) | Purpose, constraints and fallback |
| --- | --- | --- | --- |
| `resourceLimit.problemTestdataFiles` | `number`; required | `2005` | Maximum test-data file count per problem, integer ≥0. |
| `resourceLimit.problemTestdataSize` | `number`; required | `8589934592` | Maximum total test-data bytes per problem, integer ≥0; template 8 GiB. |
| `resourceLimit.problemAdditionalFileFiles` | `number`; required | `40` | Maximum additional-file count per problem, integer ≥0. |
| `resourceLimit.problemAdditionalFileSize` | `number`; required | `134217728` | Maximum total additional-file bytes per problem, integer ≥0; template 128 MiB. |
| `resourceLimit.problemSamplesToRun` | `number`; required | `10` | Maximum sample cases run for submissions, integer ≥0; 0 omits that sample stage. |
| `resourceLimit.problemTestcases` | `number`; required | `1000` | Maximum test-case count in problem judge configuration, integer ≥1. |
| `resourceLimit.problemTimeLimit` | `number`; required | `2000` | Upper bound for a problem time limit in milliseconds, integer ≥1; not a backend HTTP timeout. |
| `resourceLimit.problemMemoryLimit` | `number`; required | `512` | Upper bound for a problem memory limit in MiB, integer ≥1; not the backend Node heap size. |
| `resourceLimit.submissionFileSize` | `number`; required | `10485760` | Maximum submission-file bytes, integer ≥0; template 10 MiB. Reverse proxies, problem types and AI uploads may impose smaller limits. |

## `queryLimit` — Query limits

| Object | Rule |
| --- | --- |
| `queryLimit` | Required structural object; children are listed below. |

| Full field | Type / requirement | Source example (not default) | Purpose, constraints and fallback |
| --- | --- | --- | --- |
| `queryLimit.problemSet` | `number`; required | `100` | Maximum result count per request for problem-set queries, integer ≥1. This is a server request limit, not a default page size; check corresponding pagination relationships. |
| `queryLimit.submissions` | `number`; required | `10` | Maximum result count per request for submission-list queries, integer ≥1. This is a server request limit, not a default page size; check corresponding pagination relationships. |
| `queryLimit.submissionStatistics` | `number`; required | `10` | Maximum result count per request for submission-statistics queries, integer ≥1. This is a server request limit, not a default page size; check corresponding pagination relationships. |
| `queryLimit.searchUser` | `number`; required | `10` | Maximum result count per request for user search, integer ≥1. This is a server request limit, not a default page size; check corresponding pagination relationships. |
| `queryLimit.searchGroup` | `number`; required | `10` | Maximum result count per request for group search, integer ≥1. This is a server request limit, not a default page size; check corresponding pagination relationships. |
| `queryLimit.userList` | `number`; required | `100` | Maximum result count per request for user lists, integer ≥1. This is a server request limit, not a default page size; check corresponding pagination relationships. |
| `queryLimit.userAuditLogs` | `number`; required | `20` | Maximum result count per request for user-audit logs, integer ≥1. This is a server request limit, not a default page size; check corresponding pagination relationships. |
| `queryLimit.discussions` | `number`; required | `20` | Maximum result count per request for discussion lists/search, integer ≥1. This is a server request limit, not a default page size; check corresponding pagination relationships. |
| `queryLimit.discussionReplies` | `number`; required | `50` | Maximum result count per request for discussion-reply queries, integer ≥1. This is a server request limit, not a default page size; check corresponding pagination relationships. |

## `judge` — Limits sent to judges

| Object | Rule |
| --- | --- |
| `judge` | Required structural object; children are listed below. |
| `judge.limit` | Required structural object; children are listed below. |

| Full field | Type / requirement | Source example (not default) | Purpose, constraints and fallback |
| --- | --- | --- | --- |
| `judge.limit.compilerMessage` | `number`; required | `524288` | Maximum compiler-message bytes, positive integer; template 512 KiB. |
| `judge.limit.outputSize` | `number`; required | `104857600` | Maximum contestant-output bytes, positive integer; template 100 MiB. Judge binaryCacheMaxSize must not be smaller. |
| `judge.limit.dataDisplay` | `number`; required | `128` | Maximum displayed input/output preview bytes for ordinary judging, positive integer. |
| `judge.limit.dataDisplayForSubmitAnswer` | `number`; required | `128` | Maximum contestant-answer preview bytes for output-only tasks, positive integer; test input/reference-answer previews still use dataDisplay. |
| `judge.limit.stderrDisplay` | `number`; required | `5120` | Maximum displayed contestant stderr bytes, positive integer; template 5 KiB. |

## `eventReport` — Event reporting

| Object | Rule |
| --- | --- |
| `eventReport` | Keep the object; null token disables reporting. |

| Full field | Type / requirement | Source example (not default) | Purpose, constraints and fallback |
| --- | --- | --- | --- |
| `eventReport.telegramBotToken` | `string`; optional | `null` | Optional sensitive Telegram bot token; absent/null/empty disables reporting. Enabling sends events to Telegram; only the primary owns the bot in cluster mode. |
| `eventReport.telegramApiRoot` | `string`; optional | `null` | Optional API root URL; missing/null uses the Telegraf default Telegram API. |
| `eventReport.sentTo` | `string \| number`; optional | `@example` | Target chat ID (string or number), or a channel the bot may post to, such as @example. Supply a real destination when enabling the token. |
| `eventReport.proxyUrl` | `string`; optional | `null` | Optional ProxyAgent URL string; sensitive if it includes authentication. Applies to Telegram, not a global AI-provider proxy. |

## `vendor` — IP location databases

| Object | Rule |
| --- | --- |
| `vendor` | Keep the object even when ip2region is null. |
| `vendor.ip2region` | Optional; null uses library defaults. |

| Full field | Type / requirement | Source example (not default) | Purpose, constraints and fallback |
| --- | --- | --- | --- |
| `vendor.ip2region.ipv4db` | `string`; required when parent enabled | not set | IPv4 database file path when supplying custom ip2region data; readable by the service user. Omitting/nulling the entire block passes {} to the library for its bundled behavior. |
| `vendor.ip2region.ipv6db` | `string`; required when parent enabled | not set | IPv6 database file path when supplying custom ip2region data; readable by the service user. Omitting/nulling the entire block passes {} to the library for its bundled behavior. |


## Open dictionaries and array entries

| Path | Values and actual support |
| --- | --- |
| `services.mail.transport.*` | Options passed to Nodemailer, not a fixed LLMOJ key catalog; transport may be a URL or object. Common SMTP options are `host`, `port`, `secure`, `auth.user` and `auth.pass`; `auth.*` may include authentication-specific settings, `tls.*` supplies TLS options, `pool` selects pooling, and `jsonTransport` selects a non-delivering JSON transport. Use valid options supported by the library. LLMOJ neither merges these children nor verifies account usability at configuration validation. `auth.*` and credential-bearing URLs are sensitive. |
| `preference.misc.appLogoForTheme.*` | `*` is a frontend theme name; every value is a string. Arbitrary theme keys are accepted, but only the selected theme is read. Not a nested object. |
| `server.trustProxy[]` | Each item is a proxy address/network or Express predefined-name string. Do not substitute a single string for the array. |
| `metrics.allowedIps[]` | Each item is an IP address; an empty array allows every source, while nonempty entries use exact matching. |
| `security.crossOrigin.whiteList[]` | Each item is an origin allowed to use the xdomain proxy. |
| `preference.misc.discussionReactionEmojis[]` | Each entry is one valid emoji; the list must be nonempty and unique. |
| `preference.serverSideOnly.discussionReactionCustomEmojisBlacklist[]` | Use a flat array of emojis or `/pattern/` strings. Do not rely on the schema's permissive acceptance of deeply nested arrays. |

`services.mail.transport.auth.*` and `services.mail.transport.tls.*` belong to the transport dictionary, not a separate LLMOJ secret store. Transport values remain server-side. Verify delivery, sender identity and mail-domain policy before enabling registration email verification. The installer's JSON transport does not deliver codes to recipients.

## Registration, permissions and rate limits together

This schema has no `registrationEnabled`, email-domain allowlist, arbitrary `permissions.*`, or per-endpoint rate-limit dictionary. Adding invented YAML keys does not enable such features. `requireEmailVerification` controls registration-code verification; username rules still belong to business validation.

Per-user allow/deny rules, administrator privileges and problem/discussion/group ACLs are stored in the database, not a subtree of this file. `allowEveryone*` supplies a fallback rather than bypassing explicit denials; `ManagePermissions` remains administrator-only. AI permissions `ManageAiConfiguration`, `UseAi`, `GenerateTestdata`, `ImportProblem`, and per-account provider keys also live outside this schema; see [AI configuration](AI.md). Business permission changes are generally read from the database per request and do not require YAML edits/restarts. Sources: [permission decisions](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/user/user-privilege.service.ts), [problem authorization](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/problem/problem.service.ts).

`security.rateLimit` counts HTTP requests by `req.ip`, so configure `server.trustProxy` accurately; an incorrect proxy setup can combine many users into one IP quota. PoW and third-party CAPTCHA are separate protections: null CAPTCHA providers do not disable PoW. PoW challenges currently expire after five minutes and issuance is limited to 20 per ten seconds per IP/authenticated user. These are code constants, not YAML fields; global `maxRequests` does not change them. See [HTTP limiting](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/main.ts) and [PoW implementation](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/proof-of-work/proof-of-work.service.ts).

## Change checklist

1. Back up and edit the complete configuration actually in use; preserve identity and storage credentials. Do not replace it with the example.
2. Check `pagination` versus `queryLimit` relationships and associated port, public storage URL, mail and CAPTCHA settings.
3. Schedule a backend restart through your operational procedure; coordinate listener/proxy/credential changes with the affected services. Refresh browsers for public preference changes and verify judge reconnection for judging limits.
4. Verify login, the changed feature and logs. Successful schema validation does not prove SMTP, Telegram, database or storage connectivity.

`0` is valid only where fields permit ≥0 and does not universally mean unlimited. Administrative paths with ignore-limit permissions may bypass some problem limits. AI images, ZIP imports, model responses and local generators have separate bounds; increasing `resourceLimit` does not change them. Judge expansion belongs to the applicable operational procedure in [distributed judging](Distributed-Judging.md), not `server.clusters`.
