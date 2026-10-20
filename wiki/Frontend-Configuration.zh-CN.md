# 前端配置

简体中文 | [English](Frontend-Configuration.md) | [Wiki 首页](Home.md) | [配置总览](Configuration.zh-CN.md)

## 安装器构建的前端

安装器使用 `deploy/build-frontend-offline.mjs` 构建前端，并发布到 `<安装目录>/public`。“offline”指页面从你自己的服务器加载全部资源；构建过程本身仍可能需要下载缺少的依赖和表情图片。

脚本读取以下环境变量：

| 变量 | 含义 | 默认值 |
| --- | --- | --- |
| `OJ_SITE_NAME` | 在后端设置加载完成前显示的站点名称 | `LLMOJ` |
| `HYHOJ_PUBLIC_DIR` | 页面发布的位置。Nginx 不会随之修改 | `<安装目录>/public` |
| `HYHOJ_QUOTE_FILE` | 可选的语录 JSON 文件 | 无 |
| `PNPM_BINARY` | `--build` 使用的 pnpm 程序 | `pnpm` |

以及以下参数：

- `--build`：构建前端后发布。
- `--assets-only`：只准备本地资源，然后结束（即使同时给了 `--build`）。
- 不带参数：发布 `dist` 中已有的构建结果。

这样构建的页面从 `/frontend` 加载脚本，并调用同一站点的 API。它们按需加载的依赖库（代码编辑器、数学公式、代码高亮和表情图片）属于构建结果，位于 `/frontend/vendor` 下，不从 CDN 加载任何内容。这些值在脚本中固定。

发布时会重写输出文件和 `index.html`，并生成 `sw.js`，用于移除旧的 service worker 并清除其缓存。不要手动修改发布后的文件，下次构建时修改会丢失。

如需手动重新构建（例如修改了站点名称后），在安装目录中用安装器的 Node.js 和 pnpm 运行下面的命令。请先备份 `public`，完成后在浏览器中检查首页、登录和上传：

```bash
cd /opt/LLMOJ
sudo env PATH=/opt/LLMOJ/runtime/node/bin:/opt/LLMOJ/runtime/tooling/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  OJ_SITE_NAME="AI Practice" /opt/LLMOJ/runtime/node/bin/node deploy/build-frontend-offline.mjs --build
```

## 站点名称、标志和页脚

- **站点名称：** 在 [`backend.yaml`](Backend-Configuration.zh-CN.md) 中设置 `preference.siteName`，重新构建时把同样的名称作为 `OJ_SITE_NAME`。前者在页面加载完成后显示，后者在加载过程中显示。
- **标志：** `preference.misc.appLogo` 设置页面加载完成后显示的标志。浏览器标签页图标属于前端构建。
- **页脚：** 显示“*站点名称* Powered by LLMOJ”，其中 LLMOJ 和 GitHub 图标链接到 [houyhlouis/LLMOJ](https://github.com/houyhlouis/LLMOJ)。自定义的 `preference.copyrightNotice` 显示在下一行；内容为空或是旧的默认值 `LLMOJ`、`LibreOJ Open Source Project` 时不显示。

你的首页内容以及原有的版权、许可证和来源说明都会保留。

管理员用户菜单中的 **网站管理** 用于设置注册模式，见[注册审核](Registration-Approval.zh-CN.md)。

## 提交与 Hack 预览窗口

在提交列表或 Hack 列表中点击一项会打开预览窗口，大小为 1100 × 720 像素，屏幕较小时随之缩小。窗口显示通常的详情页，并在地址中加上 `embed=1` 以隐藏网站导航栏。窗口内的链接仍在窗口中打开；在窗口内打开的列表不会再弹出新的窗口。**#编号** 链接和普通链接打开完整页面。登录、代码可见性、比赛反馈和所有操作的权限检查与完整页面完全相同。见[提交记录](Submissions.zh-CN.md)和 [Hack](Hacks.zh-CN.md)。

## 开发时生成 API 类型

`packages/frontend/scripts/generate-api.js --from-backend-build` 从编译好的后端（`nest build` 之后的 `apps/backend/dist`）重新生成前端的 API 类型，无需运行后端。不加该选项时，它从运行在 `http://127.0.0.1:2002/docs-json` 的后端读取 API 描述；要使用其他后端，把它的 `docs-json` 完整地址作为参数传入。类型与后端不一致时会有测试失败，见 [README-DEVELOPMENT](../README-DEVELOPMENT.zh-CN.md)。

## bootstrap CDN 构建（安装器不使用）

`packages/bootstrap-config/settings.json` 属于另一种通过 CDN 发布前端的方式，继承自上游 LibreOJ。安装器不使用它，也没有在 LLMOJ 中测试过。其中的示例地址指向上游项目的服务器：使用前必须全部替换，否则你的站点会从别人的服务器加载。

文件包含两部分：

- `env`：具名的值（不是环境变量）。值中可以用 `${name}` 引用前面定义的值。示例定义了 `title`、`cdnRoot`、`apiEndpoint`、`apiEndpointCN`、`bootstrapCdnRoot`、`bootstrapCdnRootStaging`、`assets`、`favicon`、`appLogo`、`gravatar`、`gravatarCN`、`ghAvatar`、`ghAvatarCN`、`cdnjs` 和 `cdnjsCN`，也可以添加自己的值。
- `substitution`：页面中各占位符的替换内容（`__api_endpoint__`、`__default_title__`、`__public_path__`、`__favicon__`、`__applogo__`、`__gravatar__`、`__ghavatar__`、`__cdnjs__`、`__bootstrap_cdn_root__`、`__bootstrap_cdn_root_staging__`）。值可以是一个字符串，也可以是从区域到字符串的映射，其中 `""` 是默认区域，`CN` 是中国区域，例如 `{"CN": "${apiEndpointCN}", "": "${apiEndpoint}"}`。页面已不再包含 `__cdnjs__`，因为它们从构建结果本身加载依赖库，所以 `cdnjs`、`cdnjsCN` 和这项替换不再起作用。

修改后需要重新构建 bootstrap-config 和 bootstrap 应用并部署。生成的 `config.json` 中的其他字段都由构建产生。构建会读取 Git 提交信息，因此需要 Git 工作区，而不是源码压缩包。

Cloudflare 版本需要 `CLOUDFLARE_WORKER_NAME` 和 `CLOUDFLARE_ACCOUNT_ID`；发布中国区域页面的阿里云 OSS 版本需要 `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`ALIYUN_OSS_BUCKET` 和 `ALIYUN_OSS_ENDPOINT`。见[环境变量](Environment.zh-CN.md)。不要把这些凭据写进 `settings.json` 或 Wiki。

来源：[build-frontend-offline.mjs](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/build-frontend-offline.mjs)、[settings.json](https://github.com/houyhlouis/LLMOJ/blob/main/packages/bootstrap-config/settings.json)、[build.ts](https://github.com/houyhlouis/LLMOJ/blob/main/packages/bootstrap-config/src/build.ts)、[bootstrap-cloudflare/config.mjs](https://github.com/houyhlouis/LLMOJ/blob/main/apps/bootstrap-cloudflare/config.mjs)、[bootstrap-static/deploy-oss.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/bootstrap-static/deploy-oss.ts)。
