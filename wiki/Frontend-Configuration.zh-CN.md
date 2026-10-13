# 前端与 bootstrap 配置

[English](Frontend-Configuration.md) | 简体中文 | [配置总览](Configuration.zh-CN.md)

## 一键安装使用的本地前端

一键安装使用 `deploy/build-frontend-offline.mjs`：准备本地依赖、构建前端并发布到 `<root>/public`。名称中的 offline 指页面运行时依赖本地资源；首次准备缺少的依赖／emoji 等仍可能联网。

公开输入只有 `OJ_SITE_NAME`（缺省 LLMOJ）、`HYHOJ_PUBLIC_DIR`（缺省 `<root>/public`）、`HYHOJ_QUOTE_FILE`（可选语录 JSON）和 `PNPM_BINARY`（`--build` 时使用，缺省 pnpm）。`--assets-only` 只准备资产后退出；`--build` 先执行构建再发布；无参数发布已有 `dist`。不要把两个开关同时传入来期待完整构建，assets-only 会提前退出。构建时脚本设置 `NODE_OPTIONS=--max-old-space-size=2300`。

下面是脚本当前写入的固定替换，不是额外可设置的环境变量：

| 占位符 | 本地值 |
| --- | --- |
| `__public_path__` | `/frontend` |
| `__default_title__` | `OJ_SITE_NAME / LLMOJ` |
| `__api_endpoint__` | `"" → /` |
| `__favicon__` | `""` |
| `__applogo__` | `null` |
| `__gravatar__` | `https://gravatar.com` |
| `__ghavatar__` | `https://github.com` |
| `__cdnjs__` | `/cdnjs` |

改站名通常需同时更新后端 `preference.siteName` 和重新构建时的 `OJ_SITE_NAME`。`preference.misc.appLogo` 影响页面拿到公共配置后的 logo；favicon 和初始 bootstrap 资源属于前端发布。只改 `HYHOJ_PUBLIC_DIR` 不会改变 Nginx 的 `root`。本地脚本会重新整理输出资产及 `index.html`，并生成用于注销旧 service worker／清理缓存的 `sw.js`，不要把输出目录当作长期手改源码。

已有完整源码和依赖时，可在维护／构建目录执行下例；它会写入静态文件，先备份输出目录，并按实际路径和站名替换。用与安装器一致的 Node／pnpm 和文件所有权，构建完成后验证首页、资源加载、登录、上传和浏览器缓存。

```bash
cd /opt/LLMOJ
sudo env PATH=/opt/LLMOJ/runtime/node/bin:/opt/LLMOJ/runtime/tooling/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin   OJ_SITE_NAME="AI Practice"   /opt/LLMOJ/runtime/node/bin/node deploy/build-frontend-offline.mjs --build
```

## 项目入口与显示名称

页脚动态显示“站点名称 Powered by LLMOJ”，站点名称来自后端 `preference.siteName`，其中 LLMOJ 链接和 GitHub 图标指向 [houyhlouis/LLMOJ](https://github.com/houyhlouis/LLMOJ)。自定义 `preference.copyrightNotice` 另起一行保留；空白及精确默认值 `LLMOJ`、`LibreOJ Open Source Project` 不另显示重复行，不自动改写配置。页面初始标题和加载失败提示默认使用 LLMOJ。自定义首页内容、原始版权、许可证和上游来源说明继续保留。

站点管理员的用户菜单提供“网站管理”（`/site-management`），可查看当前注册方式、服务器默认值和是否启用了网页覆盖，并即时保存或恢复服务器配置。普通用户及仅获审核／首页编辑权限的用户不能进入该管理功能。已打开的注册页可刷新以显示最新模式；完整规则见 [注册审核](Registration-Approval.zh-CN.md)。

`packages/frontend/scripts/generate-api.js` 无 URL 参数时读取本机 `http://127.0.0.1:2002/docs-json`；后端位于其它地址时传入对应完整 Swagger URL。这个地址用于开发时生成接口类型，与项目 GitHub 链接是不同用途。

## 可选的上游 CDN/bootstrap 路径

`packages/bootstrap-config/settings.json` 属于另外的 bootstrap 发布体系，一键本地安装不读取它。展示标题已统一为 LLMOJ；以下 API／资源地址仍是上游发布体系的演示配置，不能直接用于自己的生产站点，否则资源或请求会指向别人的服务。这条旧发布路径本次仅核对配置结构，没有实际发布验收。

`env` 是 JSON 字典，**不是进程环境变量**。构建器按顺序展开 `${name}` 引用，后面的值可引用前面定义的键。表中列出当前全部 15 个示例键；字典可新增自定义字符串供替换引用。

| 键 | 示例值（非本地默认） | 用途 |
| --- | --- | --- |
| `env.title` | `LLMOJ` | 初始页面标题 |
| `env.cdnRoot` | `https://static.cdn.menci.xyz/libreoj-frontend` | 前端资源基址 |
| `env.apiEndpoint` | `https://api.loj.ac` | 默认区域后端地址 |
| `env.apiEndpointCN` | `https://api.loj.ac` | CN 区域后端地址 |
| `env.bootstrapCdnRoot` | `bootstrap.loj.ac.cn` | bootstrap 正式域名 |
| `env.bootstrapCdnRootStaging` | `bootstrap-staging.loj.ac.cn` | bootstrap 预发布域名 |
| `env.assets` | `https://static.cdn.menci.xyz/libreoj-assets` | favicon／logo 共用资源前缀 |
| `env.favicon` | `${assets}/favicon.ico` | 浏览器图标 URL |
| `env.appLogo` | `${assets}/logo-website.min.svg` | 站点标志 URL |
| `env.gravatar` | `https://gravatar.com` | 默认头像服务 |
| `env.gravatarCN` | `https://cravatar.cn` | CN 头像服务 |
| `env.ghAvatar` | `https://github.com` | 默认 GitHub 头像服务 |
| `env.ghAvatarCN` | `https://cdn.menci.xyz/gh-avatar` | CN GitHub 头像服务 |
| `env.cdnjs` | `https://cdnjs.cloudflare.com/ajax/libs` | 默认依赖 CDN |
| `env.cdnjsCN` | `https://cdnjs.baoshuo.ren/ajax/libs` | CN 依赖 CDN |

`substitution` 的值可为字符串（所有区域相同），或区域代码到字符串的映射；空键 `""` 是后备区域，`CN` 是现有中国区域示例，也可扩展其他区域。完整占位符及当前映射如下：

| 键 | 值 |
| --- | --- |
| `substitution.__api_endpoint__` | `{"CN": "${apiEndpointCN}", "": "${apiEndpoint}"}` |
| `substitution.__default_title__` | `"${title}"` |
| `substitution.__public_path__` | `{"": "${cdnRoot}"}` |
| `substitution.__favicon__` | `{"": "${favicon}"}` |
| `substitution.__applogo__` | `{"": "${appLogo}"}` |
| `substitution.__gravatar__` | `{"CN": "${gravatarCN}", "": "${gravatar}"}` |
| `substitution.__ghavatar__` | `{"CN": "${ghAvatarCN}", "": "${ghAvatar}"}` |
| `substitution.__cdnjs__` | `{"CN": "${cdnjsCN}", "": "${cdnjs}"}` |
| `substitution.__bootstrap_cdn_root__` | `{"": "${bootstrapCdnRoot}"}` |
| `substitution.__bootstrap_cdn_root_staging__` | `{"": "${bootstrapCdnRootStaging}"}` |

修改后需要重新构建 bootstrap-config 及对应 bootstrap 应用，再部署 HTML／service worker／静态资源。生成的 `config.json` 中 `responseDataForRegion`、`body`、`contentType`、`cacheControl`、`serviceWorker`、`buildInfo` 都是构建产物，不是新的手工配置接口。该构建路径读取 Git 提交元数据，源码归档不等价于完整 Git 工作区。

Cloudflare 变体要求 `CLOUDFLARE_WORKER_NAME`、`CLOUDFLARE_ACCOUNT_ID`，生成 `wrangler.toml`；OSS 变体要求 `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`ALIYUN_OSS_BUCKET`、`ALIYUN_OSS_ENDPOINT`，会发布 CN 区域页面。它们与一键安装无关；密钥不要写入 settings.json 或 Wiki。详见 [环境变量](Environment.zh-CN.md)。

来源：[deploy/build-frontend-offline.mjs](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/build-frontend-offline.mjs), [packages/bootstrap-config/settings.json](https://github.com/houyhlouis/LLMOJ/blob/main/packages/bootstrap-config/settings.json), [packages/bootstrap-config/src/build.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/packages/bootstrap-config/src/build.ts), [apps/bootstrap-cloudflare/config.mjs](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/bootstrap-cloudflare/config.mjs), [apps/bootstrap-static/deploy-oss.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/bootstrap-static/deploy-oss.ts).
