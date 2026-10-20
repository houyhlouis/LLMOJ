# 依赖与工具链

简体中文 | [English](Dependencies.md) | [Wiki 首页](Home.md)

LLMOJ 固定其工具链，并在 `pnpm-lock.yaml` 中锁定所用的全部软件包。本页列出受支持的版本、尚未升级的部分及原因、如何检查锁定的软件包是否有已知安全通告，以及如何更改依赖。

## 受支持的版本

| 部分 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 24.21.0（`.node-version`） | 长期支持版本，支持到 2028 年 4 月。安装程序下载此版本并校验哈希；[升级程序](Upgrade.zh-CN.md)拒绝其他版本。 |
| pnpm | 11.13.1（`package.json` 的 `packageManager`） | 安装并构建整个工作区；升级程序拒绝其他版本。 |
| TypeScript | 6.0 | 最后一个提供 JavaScript 编译器 API 的版本，后端构建和代码检查都用到它。所有软件包使用同一版本（`pnpm-workspace.yaml` 的 `catalog`）。 |
| ESLint | 10，配合 typescript-eslint 8 | 规则来自 airbnb-base，保存在 `eslint.airbnb-base.mjs` 中，因为该软件包不支持 ESLint 8 之后的版本。 |
| Prettier | 3 | |
| 后端 | NestJS 11、Express 5、TypeORM 0.3、Socket.IO 4.8、mysql2 3 | |
| 评测机 | node-addon-api 8 与 cmake-js 8 | 原生模块针对已安装的 Node.js 构建，无需下载。 |
| 前端 | React 18.3、MobX 6、Vite 8、Monaco Editor 0.57、MathJax 3、Fomantic UI 2.8、Chart.js 4 | 构建结果自成一体：见[前端构建](#前端构建)。 |
| 浏览器 | Chrome 与 Edge 111、Firefox 114、Safari 16.4（macOS 与 iOS）及更高版本 | 见[受支持的浏览器](#受支持的浏览器)。 |
| 服务器 | amd64 上的 Ubuntu 26.04 | 见[安装](Installation.zh-CN.md)。 |

## 尚未升级的部分

以下较新的版本需要各自的改动，每项都是单独的一步，不属于例行更新：

- **NestJS 12** 只以 ES 模块发布，而后端构建为 CommonJS。需要先把后端迁移到 ES 模块。
- **TypeORM 1** 是数据库层的大版本，改名并移除了一些 API，需要单独迁移并审查它生成的数据库结构。TypeORM 0.3.31 仍在维护，并已修复已知通告。
- **TypeScript 7** 尚不受 typescript-eslint 支持（它支持 6.1 之前的 TypeScript），而且 NestJS 的构建工具使用 TypeScript 7 所替换的编译器 API。
- **Node.js 26** 于 2026 年 10 月底成为长期支持版本，而 Node.js 24 支持到 2028 年 4 月。升级程序不会更换 Node.js。
- **pnpm 12** 不改变任何软件包，可以等到更换 Node.js 时一并进行。
- **ioredis 6** 和 **ejs 7** 是新的大版本；ioredis 5.11 和 ejs 3.1.10 仍在维护。
- **React 19** 移除了 Semantic UI React（组件库）所用的 `findDOMNode`，而 Navi（路由）只声明支持 React 16 和 17。两者都没有更新的版本，因此换到 React 19 意味着替换它们，这会改变页面及其地址的处理方式：这是一个单独的版本，而不是软件包更新。**MobX 7** 也等到那一步。
- **Fomantic UI 2.9** 和 **MathJax 4** 会改变组件和公式的外观，各自需要单独的视觉检查。MathJax 4 以 `mathjax` 发布，取代 `mathjax-full`。
- **markdown-it 15**：需要先检查各 Markdown 插件（提及（本项目对其打了补丁）、数学公式、合并单元格和任务列表）能否配合它工作。
- **dtsgenerator 3** 生成 API 客户端类型（`packages/frontend/src/api-generated`）的方式不同；换用它是单独的一项改动。
- **Noty**（通知）没有更新的版本；替换它属于页面改动。
- **ua-parser-js 2** 采用 AGPL-3.0 许可，而 1.x 为 MIT，因此前端继续使用 1.x。

## 受支持的浏览器

前端针对 Vite 8 所定日期（2025 年 5 月 1 日）的 [Baseline Widely Available](https://web.dev/baseline) 浏览器构建：Chrome 与 Edge 111、Firefox 114、macOS 与 iOS 上的 Safari 16.4，以及它们的更高版本。Vite 每个大版本都会推进这个日期，因此以后的 Vite 可能提高这些版本；届时本页会说明。

不再为旧浏览器单独构建。原先为它们服务的旧版构建（最低到 Firefox 52，即 Windows XP 上的最后一版；且所有 Safari 都被发往该构建）自本版本起停止。页面在加载任何内容之前，会检查受支持版本都具备的几项功能；更旧的浏览器会看到一条中英文提示，请用户使用较新版本的 Chrome、Edge、Firefox 或 Safari，而不是一个无法使用的页面。

## 前端构建

构建结果自成一体：除站点配置使用的服务（Gravatar 与 GitHub 头像、Cloudflare Turnstile、访问统计）外，页面不从其他站点加载任何内容。

- 依赖库与页面一起打包。按需加载的部分（Monaco Editor、MathJax、Prism 的各语言、Twemoji 图片）以及 Fomantic UI 和 Noty 的样式表，从各自的软件包复制到构建结果的 `vendor/<名称>/<版本>/` 下。它们的许可随站点发布在 `licenses/` 下。
- 引用其他站点的样式表会使构建失败。Fomantic UI 的页面样式表打包时去掉了对 Google Fonts 的导入；字体同样已打包。
- 数学公式、代码高亮、代码编辑器和题目地址都与以前一样。只复制页面用到的部分：页面链接的 Fomantic UI 组件，以及不含翻译的 Monaco Editor（编辑器的提示仍为英文，与以前一样）。

前端不是 ES 模块软件包（`"type": "module"`）。如果是，Vite 的打包器会像 Node.js 那样导入 CommonJS 软件包，前端对其中若干软件包的默认导入就会失效。因此 `vite.config.ts` 作为 CommonJS 加载，并用 `import()` 导入只以 ES 模块发布的插件。Vite 会警告其未来的原生配置加载器不支持这种做法；在前端迁移到 ES 模块之前，这条警告是预期之中的。

## 数据库结构如何保持不变

TypeORM 0.3.7 之后的版本建表略有不同：JSON 列成为 MariaDB 的 JSON 类型（`utf8mb4_bin`，带 `json_valid` 检查），已是主键的一对一列不再有唯一索引。实体写明了现有安装的结构：`JsonColumn`（`apps/backend/src/database/json-column.ts`）用 `longtext` 保存 JSON，各个 `REL_…` 唯一索引按名称声明。因此新旧安装的数据库结构相同，符合升级程序的[数据库约定](Community-Upgrade.zh-CN.md)。

更换数据库相关库之后，检查现有数据库的纯结构副本不需要任何改动：`deploy/upgrade-schema.mjs --action audit` 必须不报告任何语句。

## 清单与安全通告

在仓库中运行 `pnpm install` 之后：

```bash
node deploy/dependency-audit.mjs sbom sbom.cdx.json
node deploy/dependency-audit.mjs audit
```

- `sbom` 写出所有锁定软件包的 [CycloneDX](https://cyclonedx.org/) 清单：版本、仓库地址、SHA-512 哈希，以及是否只用于开发。
- `audit` 通过 `pnpm audit` 向 npm 仓库的安全通告服务查询锁定的版本，并按软件包触及通告的最暴露的途径归类：
  - **server**：后端、评测机、评测协议或沙箱的生产依赖；
  - **browser**：前端构建工具以外的软件包，可能出现在浏览器运行的页面中；
  - **build**：构建、测试和开发工具，以及安装后不会运行的 bootstrap 软件包。

触及服务器代码或浏览器代码的严重（critical）和高危（high）通告会阻止通过：除非 `deploy/dependency-triage.json` 接受它们，`audit` 以状态 1 退出。每条被接受的通告都记录它是不可触及还是被接受的风险、理由和复查日期；过了该日期它会再次阻止，以便重新审视。优先更新软件包；只有确认通告涉及的代码不会被执行时才接受它，并在理由中说明。

**Dependencies** 工作流（`.github/workflows/dependencies.yml`）在依赖或其分类变化时运行这两条命令，并且每周运行一次，因为针对未变化版本的通告也会陆续发布。清单和报告作为 `dependency-inventory` 随运行保存。

## 更改依赖

1. 修改各 `package.json` 并运行 `pnpm install`，它会更新锁文件。除非有意更换，否则保持上述工具链不变。共用的工具（TypeScript、Prettier、tsx、Node.js 类型定义）只在 `pnpm-workspace.yaml` 的 `catalog` 中设置一次。
2. 只有 `pnpm-workspace.yaml` 的 `allowBuilds` 允许时，pnpm 才会运行软件包的安装脚本。带脚本的新软件包会使安装停止，直到你在那里添加它：需要脚本（例如原生构建）时设为 `true`，否则设为 `false`。
3. 运行 `pnpm check`、各项测试以及 `node deploy/dependency-audit.mjs audit`。更换后端的数据库相关库时，按上文检查数据库结构。
4. 在服务器上，升级程序的计划会列出更改将安装的内容：见[升级](Upgrade.zh-CN.md#依赖变更)。
