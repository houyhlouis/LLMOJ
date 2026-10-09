# 后端配置完整参考

[English](Backend-Configuration.md) · [Wiki 首页](Home.zh-CN.md)

本页核对版本 `43a88bdd62fbf200889b36932fa921439a293190`，覆盖 `AppConfig` 的全部 110 个末级字段、结构对象和开放字典。它解释服务器级 `backend.yaml`，不把每道题或每场比赛的业务参数当作全站配置。

## 文件、默认值与生效方式

后端从环境变量 `LIBREOJ_CONFIG_FILE` 指定的文件读取配置；一键安装通常为 `/opt/LibreOJ/config/backend.yaml`。[ConfigService](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/config/config.service.ts) 只做 YAML 读取、类型转换、字段校验和跨字段关系校验，**不与示例文件合并，也没有通用默认值填充**。因此下表“示例值”不是“省略即可得到的默认值”；除标明可选或派生的项外，应保留完整配置。

所有项均在进程启动时读取，没有文件热重载。调整后要按运维流程重启后端；`preference`（除 `serverSideOnly`）经 `auth/getSessionInfo` 返回浏览器，后端重启后还需刷新浏览器或重新初始化应用。修改这些运行时偏好一般无需重新构建前端。`judge.limit` 在评测客户端连接时下发，应确认评测端重新连接后采用新值。不要把后端 `server.clusters` 当成评测槽数。

配置 schema 没有为所有对象使用 `IsDefined`，也没有开启配置对象的未知字段白名单剔除。不能把“拼错键没有立即报错”理解为生效；缺失对象也可能到消费者初始化时才失败。不要加入未文档化的字段，尤其不要把秘密放在公开的 `preference` 中。

依据：[字段 schema](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/config/config.schema.ts)、[关系校验](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/config/config-relation.decorator.ts)、[源码示例](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/config/backend.yaml.example)、[安装配置生成器](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/configure-local.py)。

## 示例值与首次安装值并不相同

安装器仅在配置不存在时创建文件，重跑会保留已有文件。首次安装会替换示例中的数据库、Redis、MinIO、session 和维护密钥；将 MinIO 外部地址改为站点 origin 加 `/storage/`；设置 `metrics.allowedIps: [127.0.0.1]`；以 `--site-name` 设置站名；设置 `services.mail.address: null`、`services.mail.transport: {jsonTransport: true}` 和 `preference.security.requireEmailVerification: false`。示例里的 SMTP URL、`@example` 和 `REPLACE_WITH_*` 都不是可直接运行的真实凭据。

`backend.yaml` 含敏感凭据，不要放进 Git 或上传 Wiki；安装器设置为 root 所有、后端服务组可读（0640）。修改数据库/Redis/MinIO 密码须与服务端自身配置协调；改这里不会替其它服务轮换密码。

下表用“必填”表示完整运行配置应有该项；“可选”表示可省略/null，具体消费者回退见说明；可选对象内部的必填项只在该对象启用时要求。数字是 YAML 数字，布尔值用 `true/false`，不要写成带引号的字符串。

## `server` — 监听与后端进程

| 结构对象 | 规则 |
| --- | --- |
| `server` | 必需结构对象；其子字段见下表。 |

| 完整字段 | 类型 / 是否必填 | 源码示例值（非默认） | 作用、约束和回退 |
| --- | --- | --- | --- |
| `server.hostname` | `string`; 必填 | `127.0.0.1` | 后端监听 IP；必须是 IP，不是域名。单机安装保持回环地址，公网入口由 Nginx 提供。 |
| `server.port` | `number`; 必填 | `2002` | 后端监听端口，整数 1–65535；修改时同时检查 Nginx upstream 和本机评测 serverUrl。 |
| `server.trustProxy` | 字符串数组; 必填 | `["loopback"]` | 可信反向代理的字符串数组（Express 地址/网段/预定义名称，如 loopback）。影响真实 IP、协议识别及按 IP 限流；只信任实际代理。源码类型注解写 string，但校验和使用需要数组。 |
| `server.clusters` | `number`; 可选 | `null` | 可选非负整数：省略/null 为单进程；0 开启集群且按 os.cpus().length 创建 worker；正整数为 worker 数量。不是评测槽位；增加后端进程会增加内存和监控端口占用。 |

## `metrics` — 监控

| 结构对象 | 规则 |
| --- | --- |
| `metrics` | 可省略/null 关闭监控监听。 |

| 完整字段 | 类型 / 是否必填 | 源码示例值（非默认） | 作用、约束和回退 |
| --- | --- | --- | --- |
| `metrics.hostname` | `string`; 必填（父对象启用时） | `127.0.0.1` | 启用 metrics 时必填的监听 IP；建议回环地址或受保护的监控网络。 |
| `metrics.basePort` | `number`; 必填（父对象启用时） | `2020` | 整数 1–65535。主进程使用该端口，worker 使用 basePort + worker.id；预留整个端口范围，基准值校验不会替你检查最后一个 worker 的端口。 |
| `metrics.allowedIps` | `string[]`; 可选 | `[]` | 可选 IP 数组。省略/null/[] 均不限制来源；非空时精确匹配 socket.remoteAddress（不是代理头），不接受 CIDR。安装生成 [127.0.0.1]。 |

## `services` — 数据库、对象存储、Redis 与邮件

| 结构对象 | 规则 |
| --- | --- |
| `services` | 必需结构对象；其子字段见下表。 |
| `services.database` | 必需结构对象；其子字段见下表。 |
| `services.minio` | 必需结构对象；其子字段见下表。 |
| `services.minio.default` | 必需结构对象；其子字段见下表。 |
| `services.minio.forUserUpload` | 可省略/null，使用 default。 |
| `services.minio.forUserDownload` | 可省略/null，使用 default。 |
| `services.minio.forJudge` | 可省略/null，使用 default。 |
| `services.mail` | 必需结构对象；其子字段见下表。 |

| 完整字段 | 类型 / 是否必填 | 源码示例值（非默认） | 作用、约束和回退 |
| --- | --- | --- | --- |
| `services.database.type` | `"mysql" \| "mariadb"`; 必填 | `mariadb` | 数据库驱动，仅 mysql 或 mariadb。 |
| `services.database.host` | `string`; 必填 | `127.0.0.1` | 数据库主机字符串，可为主机名或 IP。 |
| `services.database.port` | `number`; 必填 | `13306` | 数据库端口，整数 1–65535。 |
| `services.database.username` | `string`; 必填 | `libreoj` | 连接数据库的用户，不是 OJ 网站管理员。 |
| `services.database.password` | `string`; 必填 | `REPLACE_WITH_DATABASE_PASSWORD` | 敏感：数据库登录密码；安装器生成随机值，不能使用示例占位符。 |
| `services.database.database` | `string`; 必填 | `libreoj` | 使用的数据库名称；变更不会自动迁移旧库数据。 |
| `services.minio.default.endpoint` | `string`; 必填 | `http://127.0.0.1:19000` | 默认服务端对象存储连接。HTTP(S) origin，只允许根路径 /，不能含用户名密码、query 或 fragment。必需。 |
| `services.minio.default.urlEndpoint` | `string`; 可选 | `null` | 默认服务端对象存储连接生成的 URL 对外替换前缀，可包含 /storage/ 等路径，必须以 / 结尾，不可有 query/fragment。省略/null 不替换。 |
| `services.minio.forUserUpload.endpoint` | `string`; 必填（父对象启用时） | `http://127.0.0.1:19000` | 用户浏览器上传签名连接。HTTP(S) origin，只允许根路径 /，不能含用户名密码、query 或 fragment。省略此整个覆盖对象时使用 default；对象存在则应完整提供 endpoint。 |
| `services.minio.forUserUpload.urlEndpoint` | `string`; 可选 | `http://localhost/storage/` | 用户浏览器上传签名连接生成的 URL 对外替换前缀，可包含 /storage/ 等路径，必须以 / 结尾，不可有 query/fragment。省略/null 回退 default.urlEndpoint；后者为空则不替换。 |
| `services.minio.forUserDownload.endpoint` | `string`; 必填（父对象启用时） | `http://127.0.0.1:19000` | 用户浏览器下载签名连接。HTTP(S) origin，只允许根路径 /，不能含用户名密码、query 或 fragment。省略此整个覆盖对象时使用 default；对象存在则应完整提供 endpoint。 |
| `services.minio.forUserDownload.urlEndpoint` | `string`; 可选 | `http://localhost/storage/` | 用户浏览器下载签名连接生成的 URL 对外替换前缀，可包含 /storage/ 等路径，必须以 / 结尾，不可有 query/fragment。省略/null 回退 default.urlEndpoint；后者为空则不替换。 |
| `services.minio.forJudge.endpoint` | `string`; 必填（父对象启用时） | `http://127.0.0.1:19000` | 评测客户端下载签名连接。HTTP(S) origin，只允许根路径 /，不能含用户名密码、query 或 fragment。省略此整个覆盖对象时使用 default；对象存在则应完整提供 endpoint。 |
| `services.minio.forJudge.urlEndpoint` | `string`; 可选 | `http://localhost/storage/` | 评测客户端下载签名连接生成的 URL 对外替换前缀，可包含 /storage/ 等路径，必须以 / 结尾，不可有 query/fragment。省略/null 回退 default.urlEndpoint；后者为空则不替换。 |
| `services.minio.accessKey` | `string`; 必填 | `REPLACE_WITH_MINIO_ACCESS_KEY` | 敏感凭据：MinIO 访问标识；安装生成 libreoj-local，须与对象存储一致。 |
| `services.minio.secretKey` | `string`; 必填 | `REPLACE_WITH_MINIO_SECRET_KEY` | 敏感：MinIO 密钥，安装器随机生成；仅改这里会导致存储认证失败。 |
| `services.minio.bucket` | `string`; 必填 | `libreoj-files` | 文件所在 bucket 名；对象权限与签名访问仍由应用控制，改名不会搬移旧对象。 |
| `services.redis` | `string`; 必填 | `redis://:REPLACE_WITH_REDIS_PASSWORD@127.0.0.1:16379/0` | 敏感：传给 ioredis 的连接字符串，可包含密码和库编号；安装使用带随机密码的本机 16379/0。 |
| `services.mail.address` | `string`; 可选 | `no-reply@libreoj.test` | 可选有效发件邮箱；需要真正发邮件时配置，并满足 SMTP 服务允许的发件身份。安装值 null。 |
| `services.mail.transport` | URL 字符串/对象; 必填 | `smtp://username:password@smtp.libreoj.test:25` | 直接传给 Nodemailer createTransport 的 URL 或配置对象；源码没有逐项 schema 校验。含密码/OAuth 凭据时敏感。安装值 {jsonTransport: true} 只构造邮件，不投递。详见下面的开放字典说明。 |

## `security` — 会话、验证码、PoW 与限流

| 结构对象 | 规则 |
| --- | --- |
| `security` | 必需结构对象；其子字段见下表。 |
| `security.captcha` | 保留对象；两个提供商均 null 时关闭第三方验证码，不关闭 PoW。 |
| `security.captcha.turnstile` | 可选；null 关闭该提供商。 |
| `security.captcha.tencentCaptcha` | 可选；null 关闭该提供商。 |
| `security.proofOfWork` | 必需结构对象；其子字段见下表。 |
| `security.crossOrigin` | 必需结构对象；其子字段见下表。 |
| `security.rateLimit` | 可省略/null 关闭全局按 IP 限流；不关闭其它固定限流。 |

| 完整字段 | 类型 / 是否必填 | 源码示例值（非默认） | 作用、约束和回退 |
| --- | --- | --- | --- |
| `security.sessionSecret` | `string`; 必填 | `REPLACE_WITH_SESSION_SECRET` | 敏感：签名及验证登录会话 JWT 的字符串；安装随机生成。更换后现有登录令牌失效，需要重新登录。 |
| `security.maintainceKey` | `string`; 必填 | `REPLACE_WITH_MAINTENANCE_KEY` | 敏感：维护接口 POST /api/runMaintainceTasks 的 maintaince-key 请求头密钥。必须保留源码的 maintaince 拼写；不是管理员登录密码。 |
| `security.captcha.turnstile.siteKey` | `string`; 必填（父对象启用时） | 未设置 | 启用 Turnstile 时必填非空字符串；公开站点标识，将发送给浏览器。 |
| `security.captcha.turnstile.secretKey` | `string`; 必填（父对象启用时） | 未设置 | 启用 Turnstile 时必填非空字符串；敏感，服务端向 Cloudflare 校验用。 |
| `security.captcha.tencentCaptcha.appSecretKey` | `string`; 必填（父对象启用时） | 未设置 | 敏感，腾讯验证码应用密钥；1–32 个 ASCII 可见非空白字符（0x21–0x7e）。 |
| `security.captcha.tencentCaptcha.appId` | `number`; 必填（父对象启用时） | 未设置 | 腾讯验证码应用 ID，整数 ≥1；不是云账号 SecretId。 |
| `security.captcha.tencentCaptcha.secretId` | `string`; 必填（父对象启用时） | 未设置 | 敏感凭据，腾讯云非空 SecretId 字符串。 |
| `security.captcha.tencentCaptcha.secretKey` | `string`; 必填（父对象启用时） | 未设置 | 敏感，腾讯云非空 SecretKey 字符串。 |
| `security.proofOfWork.difficulty` | `number`; 必填 | `4` | 普通受保护操作的工作量证明难度，整数 1–8；不是开关，0 不合法。值越大浏览器计算越重。 |
| `security.proofOfWork.expensiveActionDifficulty` | `number`; 必填 | `5` | 提交评测及获取腾讯验证码等昂贵操作的 PoW 难度，整数 1–8；它与第三方验证码、全局限流相互独立。 |
| `security.crossOrigin.enabled` | `boolean`; 必填 | `false` | 是否提供 xdomain 跨域代理页面/脚本；不是通用 Access-Control-Allow-Origin 开关，也不自动为所有 API 开 CORS。 |
| `security.crossOrigin.whiteList` | `string[]`; 必填 | `[]` | xdomain 允许的前端 origin 字符串数组，如 https://oj.example.com；不填未经控制的站点。仅 enabled=true 时使用。 |
| `security.rateLimit.maxRequests` | `number`; 必填（父对象启用时） | `200` | 每个客户端 IP、每个窗口的请求点数上限。schema 只要求整数，运维应使用正数；超限返回 HTTP 429。rateLimit 整段省略/null 才是关闭该层。 |
| `security.rateLimit.durationSeconds` | `number`; 必填（父对象启用时） | `10` | 限流窗口秒数。schema 只校验整数，应设置正数。单进程内存计数，Node cluster 通过主进程协调；不跨独立服务器共享。 |

## `preference` — 公开偏好与服务端偏好

| 结构对象 | 规则 |
| --- | --- |
| `preference` | 公开结构，除 serverSideOnly；不要存放秘密。 |
| `preference.security` | 必需结构对象；其子字段见下表。 |
| `preference.pagination` | 必需结构对象；其子字段见下表。 |
| `preference.misc` | 必需结构对象；其子字段见下表。 |
| `preference.serverSideOnly` | 必需结构；不会发送给浏览器。 |

| 完整字段 | 类型 / 是否必填 | 源码示例值（非默认） | 作用、约束和回退 |
| --- | --- | --- | --- |
| `preference.siteName` | `string`; 必填 | `LLMOJ` | 公开的网站名称，用于页面、邮件和事件通知；安装取 --site-name（默认 LLMOJ）。 |
| `preference.copyrightNotice` | `string`; 必填 | `LibreOJ Open Source Project` | 公开页脚署名/版权文字；只是显示设置，不改变项目许可证。 |
| `preference.security.captchaEnabled` | `boolean`; 派生，不手填 | 自动派生 | 公开派生字段：实际输出由 security.captcha 是否配置任一提供商决定；这里手填 true/false 会被覆盖。 |
| `preference.security.turnstileSiteKey` | `string`; 派生，不手填 | 自动派生 | 公开派生字段：由 security.captcha.turnstile.siteKey 复制；不要把 secretKey 填到这里。 |
| `preference.security.requireEmailVerification` | `boolean`; 必填 | `true` | 注册是否验证邮箱验证码。示例 true、安装生成 false；设 true 前先配置并验证邮件投递。false 并不关闭密码重置/改邮箱等邮件需求，也不是关闭注册。 |
| `preference.security.allowUserChangeUsername` | `boolean`; 必填 | `true` | 允许普通用户修改自己的用户名；仍须有 EditOwnProfile。ManageUser 权限可走管理路径。 |
| `preference.security.allowEveryoneCreateProblem` | `boolean`; 必填 | `true` | 已登录用户建题的默认回退；不是允许访客建题，显式 CreateProblem 允许/拒绝规则仍参与判定。 |
| `preference.security.allowNonPrivilegedUserEditPublicProblem` | `boolean`; 必填 | `true` | 允许原本有权的题主或 Write ACL 用户编辑公开题；不是让任意用户编辑所有公开题，仍受全局编辑权限限制。 |
| `preference.security.allowOwnerManageProblemPermission` | `boolean`; 必填 | `false` | 题主能否管理自身题目 ACL 的回退；公开题同时受 allowNonPrivilegedUserEditPublicProblem 约束。不是授予站点 /permissions 管理。 |
| `preference.security.allowOwnerDeleteProblem` | `boolean`; 必填 | `true` | 题主删除自身题目的回退；公开题受上述公开编辑开关约束，另受显式删除权限限制。 |
| `preference.security.discussionDefaultPublic` | `boolean`; 必填 | `true` | 新建讨论默认公开标志；不追溯修改旧讨论，也不越过题目/讨论访问控制。 |
| `preference.security.discussionReplyDefaultPublic` | `boolean`; 必填 | `true` | 新回复默认公开标志；不修改既有回复。 |
| `preference.security.allowEveryoneCreateDiscussion` | `boolean`; 必填 | `true` | 已登录用户建讨论的默认回退；仍受 CreateDiscussion 显式权限和关联对象权限约束。 |
| `preference.pagination.homepageUserList` | `number`; 必填 | `10` | 公开的首页用户榜人数，整数 ≥1；没有额外的跨配置关系校验。 |
| `preference.pagination.homepageProblemList` | `number`; 必填 | `10` | 公开的首页题目数，整数 ≥1；没有额外的跨配置关系校验。 |
| `preference.pagination.problemSet` | `number`; 必填 | `50` | 公开的题库每页数量，整数 ≥1；不得超过 queryLimit.problemSet。 |
| `preference.pagination.searchProblemsPreview` | `number`; 必填 | `7` | 公开的题目搜索预览数量，整数 ≥1；不得超过 queryLimit.problemSet。 |
| `preference.pagination.submissions` | `number`; 必填 | `10` | 公开的提交列表每页数量，整数 ≥1；不得超过 queryLimit.submissions。 |
| `preference.pagination.submissionStatistics` | `number`; 必填 | `10` | 公开的提交统计每页数量，整数 ≥1；不得超过 queryLimit.submissionStatistics。 |
| `preference.pagination.userList` | `number`; 必填 | `30` | 公开的用户列表每页数量，整数 ≥1；不得超过 queryLimit.userList。 |
| `preference.pagination.userAuditLogs` | `number`; 必填 | `10` | 公开的用户审计日志每页数量，整数 ≥1；不得超过 queryLimit.userAuditLogs。 |
| `preference.pagination.discussions` | `number`; 必填 | `10` | 公开的讨论列表每页数量，整数 ≥1；不得超过 queryLimit.discussions。 |
| `preference.pagination.searchDiscussionsPreview` | `number`; 必填 | `7` | 公开的讨论搜索预览数量，整数 ≥1；不得超过 queryLimit.discussions。 |
| `preference.pagination.discussionReplies` | `number`; 必填 | `40` | 公开的讨论回复页完整数量，整数 ≥1；不得超过 queryLimit.discussionReplies。 |
| `preference.pagination.discussionRepliesHead` | `number`; 必填 | `20` | 公开的折叠时先展示的回复数，整数 ≥1；必须小于 preference.pagination.discussionReplies。 |
| `preference.pagination.discussionRepliesMore` | `number`; 必填 | `20` | 公开的继续展开时请求的回复数，整数 ≥1；不得超过 queryLimit.discussionReplies。 |
| `preference.misc.appLogo` | `string`; 必填 | `''` | Logo URL/路径字符串；空字符串使用前端默认表现。前端 window.appLogo 可覆盖，主题字典还可指定其它图片。 |
| `preference.misc.appLogoForTheme` | `Record<string, string>`; 必填 | `{"pure":"original","far":"inverted"}` | 主题名到字符串的开放字典，如 pure: original、far: inverted。值 original 使用普通 Logo，inverted 对该 Logo 反色，其它字符串作为图片路径；default 表示默认 Logo。未知主题回退 original。 |
| `preference.misc.googleAnalyticsId` | `string`; 可选 | `null` | 可选 Google Analytics 标识；null/空值不加载。公开配置，启用后浏览器会请求相应统计服务。 |
| `preference.misc.plausibleApiEndpoint` | `string`; 可选 | `null` | 可选 Plausible API URL，须通过 URL 校验；null 关闭其加载。 |
| `preference.misc.gravatarCdn` | `string`; 必填 | `https://gravatar.com` | 头像服务基础 URL 字符串，前端在后面拼 avatar/；window.gravatarCdn 可覆盖。 |
| `preference.misc.redirectLegacyUrls` | `boolean`; 必填 | `false` | 是否启用前端已定义的旧路径重定向；不自动导入老站数据或创建任意重定向规则。 |
| `preference.misc.legacyContestsEntryUrl` | 字符串/null; 可选 | `null` | 兼容保留字段，可选字符串/null。schema 的 TypeScript 注解误写 boolean，但运行时用 IsString 校验；本版本没有找到该值的页面消费者，不应承诺会显示旧比赛入口。 |
| `preference.misc.homepageUserListOnMainView` | `boolean`; 必填 | `true` | 控制首页用户列表是否放在主内容区。 |
| `preference.misc.sortUserByRating` | `boolean`; 必填 | `false` | 用户列表默认按 rating 排序的显示偏好；不计算或更新 rating。 |
| `preference.misc.renderMarkdownInUserBio` | `boolean`; 必填 | `false` | 是否将用户简介按 Markdown 渲染；不是对简介开放任意 HTML。 |
| `preference.misc.discussionReactionEmojis` | `string[]`; 必填 | `["👍","👎","😄","😕","❤️","🤔","🤣","🌿","🍋","🕊️"]` | 默认反应表情的非空、无重复数组，每项为单个有效 emoji，UTF-8 长度不超过 28 字节。 |
| `preference.misc.discussionReactionAllowCustomEmojis` | `boolean`; 必填 | `true` | 是否允许用户选择默认列表外的 emoji；仍需通过 emoji 校验及服务端黑名单。 |
| `preference.serverSideOnly.discussionReactionCustomEmojisBlacklist` | `string \| unknown[]`; 必填 | `/(\uD83C[\uDDE6-\uDDFF]){2}/` | 仅服务端：单个 emoji、/正则表达式/ 字符串，或它们的一层数组；空数组表示无黑名单。示例屏蔽旗帜。schema 递归接受嵌套数组，但消费者只 flat 一层，因此配置使用扁平数组；正则没有 flags 语法，必须本身有效。 |
| `preference.serverSideOnly.dynamicTaskPriority` | `boolean`; 必填 | `true` | 仅服务端：按题目、用户及评测状态动态计算队列优先级；false 返回统一优先级。不是并发数或限流开关。 |

## `resourceLimit` — 题目与文件资源上限

| 结构对象 | 规则 |
| --- | --- |
| `resourceLimit` | 必需结构对象；其子字段见下表。 |

| 完整字段 | 类型 / 是否必填 | 源码示例值（非默认） | 作用、约束和回退 |
| --- | --- | --- | --- |
| `resourceLimit.problemTestdataFiles` | `number`; 必填 | `2005` | 每题测试数据文件数量上限，整数 ≥0。 |
| `resourceLimit.problemTestdataSize` | `number`; 必填 | `8589934592` | 每题测试数据总字节数上限，整数 ≥0；示例 8 GiB。 |
| `resourceLimit.problemAdditionalFileFiles` | `number`; 必填 | `40` | 每题附加文件数量上限，整数 ≥0。 |
| `resourceLimit.problemAdditionalFileSize` | `number`; 必填 | `134217728` | 每题附加文件总字节数上限，整数 ≥0；示例 128 MiB。 |
| `resourceLimit.problemSamplesToRun` | `number`; 必填 | `10` | 提交时最多运行的样例组数，整数 ≥0；0 不运行该样例阶段。 |
| `resourceLimit.problemTestcases` | `number`; 必填 | `1000` | 题目评测配置的测试点数量上限，整数 ≥1。 |
| `resourceLimit.problemTimeLimit` | `number`; 必填 | `2000` | 题目允许设置的时间上限（毫秒），整数 ≥1；不是后端 HTTP 超时。 |
| `resourceLimit.problemMemoryLimit` | `number`; 必填 | `512` | 题目允许设置的内存上限（MiB），整数 ≥1；不是后端 Node 堆内存。 |
| `resourceLimit.submissionFileSize` | `number`; 必填 | `10485760` | 提交文件的字节数上限，整数 ≥0；示例 10 MiB。反向代理、具体题型和 AI 上传限制可能更小。 |

## `queryLimit` — 查询上限

| 结构对象 | 规则 |
| --- | --- |
| `queryLimit` | 必需结构对象；其子字段见下表。 |

| 完整字段 | 类型 / 是否必填 | 源码示例值（非默认） | 作用、约束和回退 |
| --- | --- | --- | --- |
| `queryLimit.problemSet` | `number`; 必填 | `100` | 题库查询单次结果数量上限，整数 ≥1。它是服务端请求上限，不是默认页面大小；同步检查对应 pagination 关系。 |
| `queryLimit.submissions` | `number`; 必填 | `10` | 提交列表查询单次结果数量上限，整数 ≥1。它是服务端请求上限，不是默认页面大小；同步检查对应 pagination 关系。 |
| `queryLimit.submissionStatistics` | `number`; 必填 | `10` | 提交统计查询单次结果数量上限，整数 ≥1。它是服务端请求上限，不是默认页面大小；同步检查对应 pagination 关系。 |
| `queryLimit.searchUser` | `number`; 必填 | `10` | 用户搜索单次结果数量上限，整数 ≥1。它是服务端请求上限，不是默认页面大小；同步检查对应 pagination 关系。 |
| `queryLimit.searchGroup` | `number`; 必填 | `10` | 用户组搜索单次结果数量上限，整数 ≥1。它是服务端请求上限，不是默认页面大小；同步检查对应 pagination 关系。 |
| `queryLimit.userList` | `number`; 必填 | `100` | 用户列表单次结果数量上限，整数 ≥1。它是服务端请求上限，不是默认页面大小；同步检查对应 pagination 关系。 |
| `queryLimit.userAuditLogs` | `number`; 必填 | `20` | 用户审计日志单次结果数量上限，整数 ≥1。它是服务端请求上限，不是默认页面大小；同步检查对应 pagination 关系。 |
| `queryLimit.discussions` | `number`; 必填 | `20` | 讨论列表及搜索单次结果数量上限，整数 ≥1。它是服务端请求上限，不是默认页面大小；同步检查对应 pagination 关系。 |
| `queryLimit.discussionReplies` | `number`; 必填 | `50` | 讨论回复查询单次结果数量上限，整数 ≥1。它是服务端请求上限，不是默认页面大小；同步检查对应 pagination 关系。 |

## `judge` — 下发给评测端的限制

| 结构对象 | 规则 |
| --- | --- |
| `judge` | 必需结构对象；其子字段见下表。 |
| `judge.limit` | 必需结构对象；其子字段见下表。 |

| 完整字段 | 类型 / 是否必填 | 源码示例值（非默认） | 作用、约束和回退 |
| --- | --- | --- | --- |
| `judge.limit.compilerMessage` | `number`; 必填 | `524288` | 编译输出保留上限，正整数字节数；示例 512 KiB。 |
| `judge.limit.outputSize` | `number`; 必填 | `104857600` | 选手输出大小上限，正整数字节数；示例 100 MiB。评测端 binaryCacheMaxSize 不可小于此值。 |
| `judge.limit.dataDisplay` | `number`; 必填 | `128` | 普通题评测结果展示的输入/输出片段上限，正整数字节数。 |
| `judge.limit.dataDisplayForSubmitAnswer` | `number`; 必填 | `128` | 提交答案题中选手答案文件的展示片段上限，正整数字节数；测试输入和标准答案预览仍用 dataDisplay。 |
| `judge.limit.stderrDisplay` | `number`; 必填 | `5120` | 选手标准错误输出的展示上限，正整数字节数；示例 5 KiB。 |

## `eventReport` — 事件通知

| 结构对象 | 规则 |
| --- | --- |
| `eventReport` | 保留对象；token 为 null 时关闭上报。 |

| 完整字段 | 类型 / 是否必填 | 源码示例值（非默认） | 作用、约束和回退 |
| --- | --- | --- | --- |
| `eventReport.telegramBotToken` | `string`; 可选 | `null` | 可选敏感 Telegram Bot token；省略/null/空字符串关闭事件上报。启用会联网向 Telegram 报告事件，集群仅主进程持有机器人。 |
| `eventReport.telegramApiRoot` | `string`; 可选 | `null` | 可选 API 根 URL；省略/null 使用 Telegraf 的默认 Telegram API。 |
| `eventReport.sentTo` | `string \| number`; 可选 | `@example` | 目标 chat ID（字符串或数字）或允许机器人发消息的频道，如 @example；token 启用后需设置真实目标。 |
| `eventReport.proxyUrl` | `string`; 可选 | `null` | 可选 ProxyAgent 代理地址字符串；含认证信息时敏感。只影响 Telegram，不是 AI 提供商的全局代理。 |

## `vendor` — IP 地理位置库

| 结构对象 | 规则 |
| --- | --- |
| `vendor` | 保留对象，即使 ip2region 为 null。 |
| `vendor.ip2region` | 可选；null 使用库默认行为。 |

| 完整字段 | 类型 / 是否必填 | 源码示例值（非默认） | 作用、约束和回退 |
| --- | --- | --- | --- |
| `vendor.ip2region.ipv4db` | `string`; 必填（父对象启用时） | 未设置 | 启用自定义 ip2region 时提供的 IPv4 数据库文件路径字符串；服务用户须能读取。整段省略/null 时向库传 {} 使用其内置行为。 |
| `vendor.ip2region.ipv6db` | `string`; 必填（父对象启用时） | 未设置 | 启用自定义 ip2region 时提供的 IPv6 数据库文件路径字符串；服务用户须能读取。整段省略/null 时向库传 {} 使用其内置行为。 |


## 开放字典与数组通配项

| 路径 | 值与实际支持 |
| --- | --- |
| `services.mail.transport.*` | Nodemailer 透传字典，不是由 LLMOJ 固定枚举的配置项；可用 URL 或对象。常用 SMTP 项是 `host`、`port`、`secure`、`auth.user`、`auth.pass`；`auth.*` 可包含认证方式特定值，`tls.*` 是 TLS 选项，`pool` 控制连接池，`jsonTransport` 为不投递的 JSON transport。填写库当前支持的有效选项，LLMOJ 不会合并这些子项或替你验证账号可用性。`auth.*`、带密码的 URL 均敏感。 |
| `preference.misc.appLogoForTheme.*` | `*` 为前端主题名，每个值必须是字符串；可设置任意主题键，但只有实际选择的主题会被读取。不是嵌套对象。 |
| `server.trustProxy[]` | 每项为代理地址、网段或 Express 预定义名称字符串，不要传单字符串替代数组。 |
| `metrics.allowedIps[]` | 每项必须是 IP；空数组允许全部连接来源，非空时精确匹配。 |
| `security.crossOrigin.whiteList[]` | 每项为允许 xdomain 代理的 origin 字符串。 |
| `preference.misc.discussionReactionEmojis[]` | 每项为有效单个 emoji，列表不得空或重复。 |
| `preference.serverSideOnly.discussionReactionCustomEmojisBlacklist[]` | 使用扁平数组中的 emoji 或 `/pattern/`，不要依赖 schema 对深层嵌套的宽松接受。 |

`services.mail.transport.auth.*` 与 `services.mail.transport.tls.*` 属于上述传输字典，并非额外的 LLMOJ secret store；所有 transport 内容留在服务端配置。配置邮件后先自行验证投递、发件人及域名策略，再开启注册邮箱验证。安装的 JSON transport 不会把验证码真正发到邮箱。

## 注册、权限与限流的组合

本站 schema 没有 `registrationEnabled`、邮件域名白名单、任意 `permissions.*` 或每接口限流字典，不能通过添加自创 YAML 键实现这些功能。`requireEmailVerification` 只控制注册验证码验证；用户名规则等仍由业务校验控制。

用户级允许/拒绝、管理员权限和题目/讨论/组 ACL 存在数据库中，不是本文件的子树。`allowEveryone*` 提供默认回退，不等于越过显式拒绝；`ManagePermissions` 仍只允许站点管理员。AI 的 `ManageAiConfiguration`、`UseAi`、`GenerateTestdata`、`ImportProblem` 及每账号提供商密钥也不在本 schema；参考 [AI 配置](AI.zh-CN.md)。业务权限变化通常按请求从数据库读取，无需为此改 YAML 或重启。依据：[权限判定](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/user/user-privilege.service.ts)、[题目授权](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/problem/problem.service.ts)。

`security.rateLimit` 在 HTTP 层按 `req.ip` 计数，必须配合准确的 `server.trustProxy`；代理配置错误会使多个用户共用一个 IP 配额。PoW 和第三方验证码是另外两层保护：将验证码提供商置 null 不会关闭 PoW。当前 PoW 挑战有效期 5 分钟，发放限制为每 IP/已登录用户 10 秒内 20 次，这些是代码常量，不是此 YAML 的字段。不要把调整全局 `maxRequests` 误认为能改变它们。参见 [HTTP 限流](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/main.ts)、[PoW 实现](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/proof-of-work/proof-of-work.service.ts)。

## 修改时核对

1. 从正在使用的完整 `backend.yaml` 备份后调整，保留身份和存储凭据；不要用示例覆盖现有文件。
2. 同步检查 `pagination` 与 `queryLimit` 的大小关系，以及端口、外部对象存储 URL、邮件和验证码的相关项。
3. 按运维流程安排后端重启；监听端口/代理/凭据变更需协调对应服务。公开偏好修改后刷新浏览器；评测限制修改后确认评测客户端重新连接。
4. 实际验证登录、需要改变的功能和日志；不要把配置通过类型校验等同于 SMTP、Telegram、数据库或对象存储已经连通。

资源限制中的 `0` 只在声明允许 ≥0 的字段合法，不普遍表示无限；具有忽略限制权限的管理路径可能绕过部分题目限制。AI 导入图片、ZIP、模型响应和本地生成器还有各自的独立限制，调大 `resourceLimit` 不会自动改那些上限。评测扩容应按 [分布式评测](Distributed-Judging.zh-CN.md) 中对应运维入口核对，不靠 `server.clusters` 完成。
