# 后端配置

简体中文 | [English](Backend-Configuration.md) | [Wiki 首页](Home.md) | [配置总览](Configuration.zh-CN.md)

本页介绍后端配置文件 `backend.yaml` 中的每项设置。这里只有全站设置；题目、比赛和权限在网站中设置。

## 文件如何读取

后端读取 `LIBREOJ_CONFIG_FILE` 指定的文件，通常是 `/opt/LLMOJ/config/backend.yaml`。它会检查每项设置的类型以及相关设置之间是否匹配，但**不会用示例文件补全缺失的设置**：下表“示例”一栏是 [backend.yaml.example](https://github.com/houyhlouis/LLMOJ/blob/main/config/backend.yaml.example) 中的值，而不是省略该设置时得到的值。请保持文件完整。

- 除标为**可选**的设置外，所有设置都必须填写。可选部分中的设置只在该部分存在时才必须填写。
- 数字和 `true`/`false` 不要加引号。
- 未知的设置不一定会报错，因此拼错的设置可能被直接忽略。不要添加本页没有列出的设置。
- 文件在后端启动时读取。修改后请重启后端；`preference` 的修改需要刷新浏览器才能看到。评测机在连接时接收 `judge.limit`。
- `preference` 下除 `preference.serverSideOnly` 之外的所有内容都会发送给浏览器，绝不能放入密钥。

该文件包含密码和密钥：不要提交到 Git，也不要贴到 Wiki 中。安装器把它设为只有 root 和后端所在组可读（权限 `0640`）。在这里修改密码不会修改 MariaDB、Redis 或 MinIO 中的密码：请两边一起修改。

### 安装器写入的内容

安装器只在文件不存在时创建它。与示例相比，它为数据库、Redis、MinIO、登录会话和维护接口使用随机密码和密钥；把 MinIO 的公开地址设为站点地址下的 `/storage/`；设置 `metrics.allowedIps: [127.0.0.1]`；使用你选择的站点名称；并通过 `services.mail.address: null`、`services.mail.transport: {jsonTransport: true}` 和 `preference.security.requireEmailVerification: false` 关闭邮件。示例中的 SMTP 地址、`@example` 和 `REPLACE_WITH_*` 都只是占位符。

## `server`：后端进程

| 设置 | 示例 | 含义 |
| --- | --- | --- |
| `server.hostname` | `127.0.0.1` | 后端监听的 IP 地址（必须是地址，不能是主机名）。安装后保持为 `127.0.0.1`，由 Nginx 对外提供服务 |
| `server.port` | `2002` | 后端监听的端口。修改时需同时修改 Nginx 和本机评测机的 `serverUrl` |
| `server.trustProxy` | `["loopback"]` | 可信代理列表，可以是地址、网段或 `loopback` 等名称。它决定后端看到的客户端 IP 和协议，限流依赖于此。只列出实际使用的代理 |
| `server.clusters` | `null` | **可选。** 后端工作进程数：省略或 `null` 为单进程，`0` 为每个 CPU 一个。进程越多，占用的内存和监控端口越多。它与评测能力无关 |

## `metrics`：Prometheus 监控指标

**可选：** 省略该部分或设为 `null` 即关闭监控指标。

| 设置 | 示例 | 含义 |
| --- | --- | --- |
| `metrics.hostname` | `127.0.0.1` | 提供监控指标的 IP 地址。请使用 `127.0.0.1` 或受保护的网络 |
| `metrics.basePort` | `2020` | 主进程的端口；工作进程使用该端口加上各自的编号，因此请保留这一段端口 |
| `metrics.allowedIps` | `[]` | **可选。** 允许读取指标的 IP 地址，与连接地址精确比较（不支持网段，也不看代理头）。为空或省略时允许所有人。安装器写入 `[127.0.0.1]` |

## `services`：数据库、文件存储、Redis 与邮件

### `services.database`

| 设置 | 示例 | 含义 |
| --- | --- | --- |
| `services.database.type` | `mariadb` | `mariadb` 或 `mysql` |
| `services.database.host` | `127.0.0.1` | 数据库主机名或 IP 地址 |
| `services.database.port` | `13306` | 数据库端口 |
| `services.database.username` | `libreoj` | 数据库用户（不是网站账号） |
| `services.database.password` | `REPLACE_WITH_DATABASE_PASSWORD` | 数据库密码，安装时随机生成。属于密钥 |
| `services.database.database` | `libreoj` | 数据库名。修改它不会移动已有数据 |

### `services.minio`

后端为 MinIO 签发上传和下载链接。`default` 用于后端自身的访问；可选的 `forUserUpload`、`forUserDownload` 和 `forJudge` 部分分别覆盖提供给浏览器上传、浏览器下载和评测机的链接。每个部分包含：

- `endpoint`（该部分存在时必填）：后端访问 MinIO 的地址，例如 `http://127.0.0.1:19000`，不能包含路径、用户名、查询参数或片段；
- `urlEndpoint`（**可选**）：在签发的链接中替换 `endpoint` 的公开地址，可以包含路径且必须以 `/` 结尾，例如 `https://oj.example.com/storage/`。缺少时使用 `default` 的值；`default` 也没有时不改写链接。

| 设置 | 示例 | 含义 |
| --- | --- | --- |
| `services.minio.default.endpoint` | `http://127.0.0.1:19000` | 后端访问 MinIO 的地址 |
| `services.minio.default.urlEndpoint` | `null` | **可选。** 用 `default` 签发的链接的公开地址 |
| `services.minio.forUserUpload.*` | endpoint `http://127.0.0.1:19000`，urlEndpoint `http://localhost/storage/` | **可选部分。** 浏览器上传的链接 |
| `services.minio.forUserDownload.*` | 同上 | **可选部分。** 浏览器下载的链接 |
| `services.minio.forJudge.*` | 同上 | **可选部分。** 评测机下载测试数据的链接 |
| `services.minio.accessKey` | `REPLACE_WITH_MINIO_ACCESS_KEY` | MinIO 用户，安装后为 `libreoj-local`。必须与 MinIO 自身的配置一致 |
| `services.minio.secretKey` | `REPLACE_WITH_MINIO_SECRET_KEY` | MinIO 密码，安装时随机生成。属于密钥，必须与 MinIO 自身的配置一致 |
| `services.minio.bucket` | `libreoj-files` | 保存所有文件的存储桶。改名不会移动已有文件 |

### `services.redis` 与 `services.mail`

| 设置 | 示例 | 含义 |
| --- | --- | --- |
| `services.redis` | `redis://:REPLACE_WITH_REDIS_PASSWORD@127.0.0.1:16379/0` | Redis 地址，包含密码和数据库编号。属于密钥。密码中的特殊字符需要百分号编码 |
| `services.mail.address` | `no-reply@libreoj.test` | **可选。** 发件地址，必须被你的邮件服务器接受。安装后为 `null` |
| `services.mail.transport` | `smtp://username:password@smtp.libreoj.test:25` | 发送邮件的方式：SMTP 地址或选项对象，原样传给 [Nodemailer](https://nodemailer.com/smtp/)（例如 `host`、`port`、`secure`、`auth.user`、`auth.pass`、`tls`、`pool`）。安装后为 `{jsonTransport: true}`，不会发送任何邮件。包含密码时属于密钥 |

LLMOJ 不会检查邮件能否真正发出。开启邮箱验证之前，请先给自己发一封测试邮件。

## `security`：登录会话、验证码、工作量证明与限流

| 设置 | 示例 | 含义 |
| --- | --- | --- |
| `security.sessionSecret` | `REPLACE_WITH_SESSION_SECRET` | 签名登录会话的密钥，安装时随机生成。属于密钥。修改后所有人都需要重新登录 |
| `security.sessionIdleTimeoutDays` | `30` | **可选。** 登录会话连续这么多天未使用即失效。`0` 表示永不失效；省略时为 30 |
| `security.sessionMaxAgeDays` | `90` | **可选。** 登录会话在登录这么多天后失效，即使一直在使用。`0` 表示永不失效；省略时为 90 |
| `security.adminSessionIdleTimeoutDays` | `3` | **可选。** 站点管理员的会话连续这么多天未使用即失效（比 `sessionIdleTimeoutDays` 更短时生效）。`0` 表示不另设限制；省略时为 3 |
| `security.adminSessionMaxAgeDays` | `30` | **可选。** 站点管理员的会话在登录这么多天后失效（比 `sessionMaxAgeDays` 更短时生效）。`0` 表示不另设限制；省略时为 30 |
| `security.sessionCookie` | `true` | **可选。** 与 API 同源的页面把登录会话保存在 HttpOnly Cookie 中，页面脚本无法读取；通过 HTTPS 访问时还会标记为 `Secure`。设为 `false` 时，登录后页面得到会话令牌，与以前相同；已有的 Cookie 会话在结束前仍可使用。其他源的页面和 API 客户端总是在 `Authorization` 请求头中发送令牌。省略时为 `true` |
| `security.maintainceKey` | `REPLACE_WITH_MAINTENANCE_KEY` | `POST /api/runMaintainceTasks` 的 `maintaince-key` 请求头所需的密钥（拼写如此，请勿更正）。属于密钥 |
| `security.proofOfWork.difficulty` | `4` | 受保护操作的工作量证明难度，1～8。值越大浏览器计算越久。不能关闭 |
| `security.proofOfWork.expensiveActionDifficulty` | `5` | 提交等高开销操作的工作量证明难度，1～8 |
| `security.crossOrigin.enabled` | `false` | 提供 xdomain 跨域代理页面。它不会为 API 开启 CORS |
| `security.crossOrigin.whiteList` | `[]` | 允许使用 xdomain 代理的前端地址，例如 `https://oj.example.com` |
| `security.rateLimit.maxRequests` | `200` | 每个客户端 IP 在每个时段内允许的请求数；超出时返回 HTTP 429 |
| `security.rateLimit.durationSeconds` | `10` | 时段长度（秒）。计数保存在内存中，不在服务器之间共享 |

`security.rateLimit` 是**可选的**：省略即关闭通用限流。它按后端看到的客户端 IP 计数，因此请正确设置 `server.trustProxy`，否则许多用户可能共用一个地址的限额。有些限制固定在代码中：工作量证明题目 5 分钟后过期，每个 IP 或用户每 10 秒最多获取 20 个。

### 验证码

`security.captcha` 必须存在。它有两个**可选**的提供商 `turnstile` 和 `tencentCaptcha`；都设为 `null` 即关闭验证码。工作量证明与它相互独立。

| 设置 | 含义 |
| --- | --- |
| `security.captcha.turnstile.siteKey` | Cloudflare Turnstile 站点密钥（公开，会发送给浏览器） |
| `security.captcha.turnstile.secretKey` | Turnstile 私密密钥。属于密钥 |
| `security.captcha.tencentCaptcha.appId` | 腾讯验证码应用 ID，正整数 |
| `security.captcha.tencentCaptcha.appSecretKey` | 腾讯验证码应用密钥：1～32 个不含空格的可打印 ASCII 字符。属于密钥 |
| `security.captcha.tencentCaptcha.secretId` | 腾讯云 SecretId。属于密钥 |
| `security.captcha.tencentCaptcha.secretKey` | 腾讯云 SecretKey。属于密钥 |

## `preference`：网站行为与显示

### 通用

| 设置 | 示例 | 含义 |
| --- | --- | --- |
| `preference.siteName` | `LLMOJ` | 显示在页面、页脚、邮件和事件通知中的站点名称 |
| `preference.copyrightNotice` | `LLMOJ` | 页脚“*站点名称* Powered by LLMOJ”下方的额外一行。为空或为 `LLMOJ`、`LibreOJ Open Source Project` 时不显示 |

### `preference.security`

| 设置 | 示例 | 含义 |
| --- | --- | --- |
| `preference.security.registrationMode` | `open` | **可选。** `open`、`approval` 或 `closed`（省略时为 `open`）。在 **网站管理** 中保存的模式优先。见[注册审核](Registration-Approval.zh-CN.md) |
| `preference.security.requireEmailVerification` | `true` | 注册、修改邮箱和重置密码时通过邮件发送验证码。请先确认邮件能正常发送。设为 `false` 时不发送验证码：注册和修改邮箱不需要验证码，也无法通过邮件找回密码（可由用户管理员设置新密码） |
| `preference.security.allowUserChangeUsername` | `true` | 用户可以修改自己的用户名（还需要编辑自己资料的权限） |
| `preference.security.allowEveryoneCreateProblem` | `true` | 已登录用户可以创建题目，除非权限规则另有规定 |
| `preference.security.allowNonPrivilegedUserEditPublicProblem` | `true` | 题目公开后，题目所有者或有写权限的用户仍可编辑 |
| `preference.security.allowOwnerManageProblemPermission` | `false` | 题目所有者可以修改谁能访问该题（公开题目还需开启上一项） |
| `preference.security.allowOwnerDeleteProblem` | `true` | 题目所有者可以删除该题（公开题目还需允许编辑公开题目） |
| `preference.security.discussionDefaultPublic` | `true` | 新讨论默认公开 |
| `preference.security.discussionReplyDefaultPublic` | `true` | 新回复默认公开 |
| `preference.security.allowEveryoneCreateDiscussion` | `true` | 已登录用户可以发起讨论，除非权限规则另有规定 |

以 “allow” 开头的设置只是默认值：**权限管理** 页面中明确的权限规则仍然优先。不要在这里设置 `captchaEnabled` 或 `turnstileSiteKey`：后端会根据 `security.captcha` 自动填写。

**邮箱验证码。** 每个验证码只用于一种用途（注册、修改邮箱或重置密码），只对它发往的邮箱有效（不区分大小写）；修改邮箱和重置密码的验证码还只对申请它的账号有效。验证码只能使用一次：两个请求同时使用同一个验证码，也只有一个会成功。如果之后的修改失败（很少见），请重新获取验证码。验证码 15 分钟后过期，同一邮箱同一用途的新验证码会使旧的失效；同一邮箱每分钟最多发送一个验证码。一个验证码输错 5 次后失效；同一邮箱的每种用途每小时最多接受 20 次错误输入，不论针对哪个验证码。页面不会说明是哪种情况，只会提示重新获取验证码。重置密码和修改邮箱时输错验证码会记入该用户的审计日志，但不会记录验证码本身。升级到此版本之前发送的验证码将失效。

### `preference.pagination`

每页显示的数量。每项至少为 1；如果列出了对应的 `queryLimit`，则不能超过它。

| 设置 | 示例 | 页面 | 上限 |
| --- | --- | --- | --- |
| `preference.pagination.homepageUserList` | `10` | 首页用户 | |
| `preference.pagination.homepageProblemList` | `10` | 首页题目 | |
| `preference.pagination.problemSet` | `50` | 题库 | `queryLimit.problemSet` |
| `preference.pagination.searchProblemsPreview` | `7` | 题目搜索建议 | `queryLimit.problemSet` |
| `preference.pagination.submissions` | `10` | 提交记录 | `queryLimit.submissions` |
| `preference.pagination.submissionStatistics` | `10` | 提交统计 | `queryLimit.submissionStatistics` |
| `preference.pagination.userList` | `30` | 用户列表 | `queryLimit.userList` |
| `preference.pagination.userAuditLogs` | `10` | 审计日志 | `queryLimit.userAuditLogs` |
| `preference.pagination.discussions` | `10` | 讨论 | `queryLimit.discussions` |
| `preference.pagination.searchDiscussionsPreview` | `7` | 讨论搜索建议 | `queryLimit.discussions` |
| `preference.pagination.discussionReplies` | `40` | 完整页面中的回复 | `queryLimit.discussionReplies` |
| `preference.pagination.discussionRepliesHead` | `20` | 展开前显示的回复 | 小于 `discussionReplies` |
| `preference.pagination.discussionRepliesMore` | `20` | 每次展开加载的回复 | `queryLimit.discussionReplies` |

### `preference.misc`

| 设置 | 示例 | 含义 |
| --- | --- | --- |
| `preference.misc.appLogo` | `''` | 标志图片地址；为空时使用默认标志 |
| `preference.misc.appLogoForTheme` | `{"pure": "original", "far": "inverted"}` | 各主题使用的标志：`original`（正常标志）、`inverted`（反色的正常标志）、`default`（默认标志）或图片地址。未列出的主题使用 `original` |
| `preference.misc.googleAnalyticsId` | `null` | **可选。** Google Analytics ID；为空即关闭。开启后浏览器会访问 Google |
| `preference.misc.plausibleApiEndpoint` | `null` | **可选。** Plausible Analytics 地址；为空即关闭 |
| `preference.misc.gravatarCdn` | `https://gravatar.com` | 头像服务地址（会在后面加上 `avatar/`） |
| `preference.misc.redirectLegacyUrls` | `false` | 把旧版 LibreOJ 的页面地址重定向到当前地址 |
| `preference.misc.legacyContestsEntryUrl` | `null` | **可选。** 为兼容而保留，目前未使用 |
| `preference.misc.homepageUserListOnMainView` | `true` | 在首页主栏显示用户列表 |
| `preference.misc.sortUserByRating` | `false` | 按 rating 排序用户（不会计算 rating） |
| `preference.misc.renderMarkdownInUserBio` | `false` | 用 Markdown 显示用户简介（不会显示原始 HTML） |
| `preference.misc.discussionReactionEmojis` | `["👍","👎","😄","😕","❤️","🤔","🤣","🌿","🍋","🕊️"]` | 讨论中提供的表情回应：至少一个、不能重复，每个都是单个表情，最多 28 字节 |
| `preference.misc.discussionReactionAllowCustomEmojis` | `true` | 用户也可以使用其他表情回应，但下面屏蔽的除外 |

### `preference.serverSideOnly`

不会发送给浏览器。

| 设置 | 示例 | 含义 |
| --- | --- | --- |
| `preference.serverSideOnly.discussionReactionCustomEmojisBlacklist` | `/(\uD83C[\uDDE6-\uDDFF]){2}/` | 禁止用于回应的表情：一个表情、一个 `/正则表达式/`，或由它们组成的一层列表（`[]` 表示不屏蔽）。示例屏蔽旗帜。不支持正则表达式标志 |
| `preference.serverSideOnly.dynamicTaskPriority` | `true` | 根据提交、题目和用户调整评测队列的顺序；`false` 时按到达顺序评测 |

## `resourceLimit`：题目与文件限制

| 设置 | 示例 | 含义 |
| --- | --- | --- |
| `resourceLimit.problemTestdataFiles` | `2005` | 每道题的测试数据文件数 |
| `resourceLimit.problemTestdataSize` | `8589934592`（8 GiB） | 每道题测试数据的总大小（字节） |
| `resourceLimit.problemAdditionalFileFiles` | `40` | 每道题的附加文件数 |
| `resourceLimit.problemAdditionalFileSize` | `134217728`（128 MiB） | 每道题附加文件的总大小（字节） |
| `resourceLimit.problemSamplesToRun` | `10` | 评测提交时在测试点之前运行的样例数；`0` 表示不运行 |
| `resourceLimit.problemTestcases` | `1000` | 每道题的测试点数（至少 1） |
| `resourceLimit.problemTimeLimit` | `2000` | 题目可设置的最大时间限制（毫秒） |
| `resourceLimit.problemMemoryLimit` | `512` | 题目可设置的最大内存限制（MiB） |
| `resourceLimit.submissionFileSize` | `10485760`（10 MiB） | 提交文件的最大大小（字节）。Nginx、前面的代理或题目类型可能允许得更少 |

在合理的地方可以填 `0`，它表示“没有”，而不是“不限制”。有权忽略限制的用户可以超出其中部分限制。AI 导入和生成有各自的限制，这些设置不会改变它们。

## `queryLimit`：后端单次返回的最大数量

这些设置限制单个请求最多能获取多少条数据；`preference.pagination` 中的每页数量不能超过它们。每项至少为 1。

| 设置 | 示例 | 适用于 |
| --- | --- | --- |
| `queryLimit.problemSet` | `100` | 题库和题目搜索 |
| `queryLimit.submissions` | `10` | 提交记录 |
| `queryLimit.submissionStatistics` | `10` | 提交统计 |
| `queryLimit.searchUser` | `10` | 用户搜索 |
| `queryLimit.searchGroup` | `10` | 用户组搜索 |
| `queryLimit.userList` | `100` | 用户列表 |
| `queryLimit.userAuditLogs` | `20` | 审计日志 |
| `queryLimit.discussions` | `20` | 讨论和讨论搜索 |
| `queryLimit.discussionReplies` | `50` | 讨论回复 |

## `judge.limit`：发送给评测机的限制

| 设置 | 示例 | 含义 |
| --- | --- | --- |
| `judge.limit.compilerMessage` | `524288`（512 KiB） | 保留的编译输出（字节） |
| `judge.limit.outputSize` | `104857600`（100 MiB） | 程序最多可输出的大小（字节）。每台评测机的 `binaryCacheMaxSize` 必须不小于它 |
| `judge.limit.dataDisplay` | `128` | 结果中显示的输入和输出字节数 |
| `judge.limit.dataDisplayForSubmitAnswer` | `128` | 结果中显示的提交答案文件字节数（用于提交答案题） |
| `judge.limit.stderrDisplay` | `5120`（5 KiB） | 结果中显示的程序标准错误字节数 |

## `eventReport`：Telegram 通知

该部分必须存在；`telegramBotToken` 留空即关闭通知。

| 设置 | 示例 | 含义 |
| --- | --- | --- |
| `eventReport.telegramBotToken` | `null` | **可选。** Telegram 机器人令牌。属于密钥。设置后，后端会把站点事件发送到 Telegram |
| `eventReport.telegramApiRoot` | `null` | **可选。** 非默认的 Telegram API 地址 |
| `eventReport.sentTo` | `@example` | **可选。** 聊天 ID，或机器人可以发消息的频道 |
| `eventReport.proxyUrl` | `null` | **可选。** 仅用于 Telegram 的代理。包含密码时属于密钥 |

## `vendor`：IP 地址归属地

该部分必须存在。`vendor.ip2region` 是**可选的**：省略时使用库自带的归属地数据。

| 设置 | 含义 |
| --- | --- |
| `vendor.ip2region.ipv4db` | 你自己的 ip2region IPv4 数据库路径，后端必须能读取 |
| `vendor.ip2region.ipv6db` | 你自己的 ip2region IPv6 数据库路径，后端必须能读取 |

## 不在这个文件中的设置

- 在 **网站管理** 中保存的注册模式，它会立即覆盖 `preference.security.registrationMode`，无需重启。
- 用户、用户组、题目和讨论的权限及访问规则，包括 `ManageRegistrationReviews` 和 AI 权限（`ManageAiConfiguration`、`UseAi`、`GenerateTestdata`、`ImportProblem`）。它们保存在数据库中，无需重启即可生效，在 **权限管理** 页面设置；见[注册审核](Registration-Approval.zh-CN.md)和 [AI](AI.zh-CN.md)。
- 每位用户的 AI 服务商密钥，见 [AI](AI.zh-CN.md)。
- 评测能力，见[评测配置](Judge-Configuration.zh-CN.md)。

除注册模式外，没有开关注册的设置，也没有允许的邮箱域名或按接口限流的设置；添加这样的键不会有任何作用。

## 修改文件

1. 备份正在使用的文件后再修改；不要用示例替换它，否则会丢失你的密码和密钥。
2. 检查每页数量没有超过对应的 `queryLimit`，并确认端口、公开存储地址、邮件和验证码设置相互匹配。
3. 重启后端。修改监听地址、代理和密码时，请同时修改受影响的服务。刷新浏览器；如果修改了 `judge.limit`，请确认评测机重新连接。
4. 检查能否登录、修改是否生效，以及日志中是否有错误。文件通过后端检查并不代表邮件、Telegram、数据库或存储一定能连通。

来源：[config.schema.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/config/config.schema.ts)、[config-relation.decorator.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/config/config-relation.decorator.ts)、[backend.yaml.example](https://github.com/houyhlouis/LLMOJ/blob/main/config/backend.yaml.example)、[configure-local.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-local.py)。
