# 使用 API

简体中文 | [English](API.md) | [Wiki 首页](Home.md)

网站上的所有操作都经过后端的 HTTP API，脚本也可以同样使用：列出题目、提交、跟踪评测、导出成绩。本页说明所有接口共同的约定。谁可以调用什么，见[权限](Permissions.zh-CN.md)。

## 接口与接口说明

- 接口地址是 `https://<你的站点>/api/<模块>/<操作>`，例如 `/api/problem/queryProblemSet`。几乎都是 `POST`，请求体为 JSON（`Content-Type: application/json`），回答也是 JSON；少数读取接口用 `GET`。
- 后端用 OpenAPI 描述每个接口及其请求和回答：后端自身的 `/docs` 页面和 `/docs-json` 文档。安装后的 Nginx 只转发 `/api/`，所以请在服务器上打开（`http://127.0.0.1:2002/docs`，或通过 SSH 隧道），或使用[开发环境](Development.zh-CN.md)。
- 网站自己的 TypeScript 客户端由这份说明生成，位于 `packages/frontend/src/api-generated`（`types.d.ts` 包含所有请求和回答的类型）。修改后端 API 后，先构建后端，再运行 `node packages/frontend/scripts/generate-api.js --from-backend-build` 重新生成。

## 登录

1. `POST /api/auth/login`，请求体为 `{"username": "...", "password": "..."}`（也可以用 `"email"` 代替 `"username"`）。需要[工作量证明](#工作量证明与人机验证)。
2. 回答中有 `token`。之后每个请求都带上它：`Authorization: Bearer <token>`。
3. 开启了[两步验证](Two-Factor-Sign-In.zh-CN.md)的账号会收到 `twoFactorChallenge`。再用 `POST /api/twoFactor/completeLogin` 提交这个 `challenge` 和验证器应用给出的 `totpCode`（或 `recoveryCode`），即可得到 token。
4. `POST /api/auth/logout` 结束会话。站点也可能结束会话（过期、在别处退出或被撤销）：这时回答带有响应头 `X-Session-Ended: 1`，请求按访客处理。请重新登录。

与 API 同源的网站页面把会话保存在 HttpOnly Cookie 中（它们发送 `X-Session-Mode: cookie`，得到的 `cookie:<会话编号>` 标记不是凭据）。脚本和其他来源的页面始终使用 token。token 就是该账号的完整会话：请妥善保管，并使用只具有脚本所需权限的账号。

有些修改（密码、邮箱、两步验证设置等）需要最近输入过密码：回答为错误 `REAUTHENTICATION_REQUIRED`，且没有做任何修改。按[确认敏感操作](Two-Factor-Sign-In.zh-CN.md#确认敏感操作)确认密码后，再次发送请求。

## 工作量证明与人机验证

会消耗站点资源的请求（登录、注册、发送邮箱验证码、重置密码、创建题目或给题目添加文件、准备答案文件上传、提交、发表讨论或回复）需要工作量证明：

1. `POST /api/proofOfWork/issueChallenge`，请求体为 `{"action": "submit_problem"}`（即该请求对应的操作；生成的客户端里有各操作的名称）。回答包含 `id`、`randomData`、`difficulty` 和 `expiresAt`。
2. 找一个整数 `nonce`（0、1、2……），使 `randomData` 后接十进制 nonce 的 SHA-256 十六进制结果以 `difficulty` 个 0 开头。
3. 发送请求时带上响应头 `X-Proof-Of-Work: {"id": "...", "nonce": 12345, "response": "<十六进制哈希>"}`。

一个挑战只能用一次，只用于一种操作，只对申请它的地址（和会话）有效，有效期 5 分钟。每个客户端 10 秒内最多申请 20 个挑战。难度由[后端配置](Backend-Configuration.zh-CN.md)中的 `security.proofOfWork.difficulty` 决定（提交使用 `expensiveActionDifficulty`）。站点开启人机验证时，提交还需要响应头 `X-Captcha-Result`，脚本无法生成它。

具有**跳过人机验证**特权（由管理员在账号的**特权**页设置）的账号两者都不需要。请把它授予专门给机器人或虚拟评测使用的账号，不要授予普通用户。

## 回答与错误

- **成功：** HTTP 200 或 201，回答为 JSON。
- **预期内的失败**放在回答中，HTTP 状态仍为 200 或 201：`{"error": "NO_SUCH_PROBLEM"}`、`{"error": "PERMISSION_DENIED"}` 等。生成的客户端列出了每个接口的错误码。
- **HTTP 错误：** 400 表示请求格式不对（响应体指出无效的字段）；403 表示站点权限或工作量证明拒绝了请求；404；409 表示请求与同时进行的修改冲突（请重新发送）；429 表示该地址请求过多（`security.rateLimit`：默认 10 秒 200 个）；500 `{"error": "INTERNAL_ERROR", "requestId": "..."}` 表示意外故障。
- **请求编号：** 每个回答都有 `X-Request-Id` 响应头，服务器错误还会在响应体中重复它。报告问题时请附上它：服务器日志中该请求的记录带有同一编号。

## 分页

列表按页读取：`skipCount`（跳过多少条）和 `takeCount`（返回多少条），每个接口都有上限（后端配置中的 `queryLimit`；`takeCount` 超过上限会被拒绝）。有总数的接口会在回答中给出 `count`。比赛中的列表改用 `page`，每页 50 行。读取期间结果可能变化：要读取全部内容，请按编号范围或筛选条件读取，不要只靠页码。

## 上传文件

文件（答案压缩包、测试数据、附件、团队文件）不经过后端。每次上传分三步：

1. 调用接口时带上 `uploadInfo: {"size": <字节数>, "uuid": null}`（有些接口有单独的准备接口，例如 `submission/prepareFileUpload`）。回答中有 `signedUploadRequest`：`method`、`url`、`extraFormData`、`fileFieldName` 和本次上传的 `uuid`。
2. 把文件发送到这个 `url`：如果是 `POST`，以 multipart 表单发送，带上 `extraFormData` 中的字段，文件放在 `fileFieldName` 字段。表单 10 分钟内有效，只接受声明的大小。
3. 再次调用接口，带上 `uploadInfo: {"size": <字节数>, "uuid": "<上传的 uuid>"}`。

第 3 步中，后端把上传的对象复制到任何表单都不能写入的新对象中，检查大小并记录 SHA-256，然后才随这次修改登记文件。`FILE_NOT_UPLOADED` 表示找不到上传的文件（已过期或未发送），大小不符会被拒绝。

## 实时跟踪评测

提交页面通过 Socket.IO 4 实时更新：

- 连接站点地址，路径为 `/api/socket`，命名空间为 `/submission-progress`，只用 `websocket` 传输，并使用 [msgpack 解析器](https://github.com/socketio/socket.io-msgpack-parser)。
- 握手参数中带 `subscriptionKey`：即提交仍在评测时 `submission/querySubmission` 和 `submission/getSubmissionDetail` 返回的 `progressSubscriptionKey`。它属于获取它的账号和会话，24 小时内有效。
- 服务器发送 `message` 事件，包含提交编号和一个 [jsondiffpatch](https://github.com/benjamine/jsondiffpatch) 差异，它相对于本连接上该提交的上一条消息；某个提交的第一条消息相对于空值。每条消息发送前都会重新检查权限。
- **断开之后**，新的连接会重新开始：每个提交的第一条消息又是完整的，所以只在同一个连接内应用差异。如果是服务器主动关闭了连接（例如退出登录后它不再接受这个 key），不要用同一个 key 重试：重新通过 API 读取这些提交；它们仍在评测时，会得到新的 key。

同一路径上的 `/judge` 命名空间供[评测机](Distributed-Judging.zh-CN.md)使用，不供客户端使用。

## 示例

用 `curl` 和登录得到的 token：

```bash
curl -s https://oj.example.com/api/problem/queryProblemSet \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"locale": "zh_CN", "skipCount": 0, "takeCount": 20}'
```

回答列出这个账号能看到的题目以及 `count`。想在不影响真实站点的情况下试验请求，请启动[开发环境](Development.zh-CN.md)并使用其中的后端。
