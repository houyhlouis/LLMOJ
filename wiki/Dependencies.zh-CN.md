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
| 服务器 | amd64 上的 Ubuntu 26.04 | 见[安装](Installation.zh-CN.md)。 |

## 尚未升级的部分

以下较新的版本需要各自的改动，每项都是单独的一步，不属于例行更新：

- **NestJS 12** 只以 ES 模块发布，而后端构建为 CommonJS。需要先把后端迁移到 ES 模块。
- **TypeORM 1** 是数据库层的大版本，改名并移除了一些 API，需要单独迁移并审查它生成的数据库结构。TypeORM 0.3.31 仍在维护，并已修复已知通告。
- **TypeScript 7** 尚不受 typescript-eslint 支持（它支持 6.1 之前的 TypeScript），而且 NestJS 的构建工具使用 TypeScript 7 所替换的编译器 API。
- **Node.js 26** 于 2026 年 10 月底成为长期支持版本，而 Node.js 24 支持到 2028 年 4 月。升级程序不会更换 Node.js。
- **pnpm 12** 不改变任何软件包，可以等到更换 Node.js 时一并进行。
- **ioredis 6** 和 **ejs 7** 是新的大版本；ioredis 5.11 和 ejs 3.1.10 仍在维护。
- **jsondiffpatch 0.7**：后端用它生成实时更新，浏览器用它应用这些更新，两者须一同更换，随前端一起进行。

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

触及服务器代码的严重（critical）和高危（high）通告会阻止通过：除非 `deploy/dependency-triage.json` 接受它们，`audit` 以状态 1 退出。浏览器代码要到下一版本替换前端构建之后才会阻止。每条被接受的通告都记录它是不可触及还是被接受的风险、理由和复查日期；过了该日期它会再次阻止，以便重新审视。优先更新软件包；只有确认通告涉及的代码不会被执行时才接受它，并在理由中说明。

**Dependencies** 工作流（`.github/workflows/dependencies.yml`）在依赖或其分类变化时运行这两条命令，并且每周运行一次，因为针对未变化版本的通告也会陆续发布。清单和报告作为 `dependency-inventory` 随运行保存。

## 更改依赖

1. 修改各 `package.json` 并运行 `pnpm install`，它会更新锁文件。除非有意更换，否则保持上述工具链不变。共用的工具（TypeScript、Prettier、tsx、Node.js 类型定义）只在 `pnpm-workspace.yaml` 的 `catalog` 中设置一次。
2. 只有 `pnpm-workspace.yaml` 的 `allowBuilds` 允许时，pnpm 才会运行软件包的安装脚本。带脚本的新软件包会使安装停止，直到你在那里添加它：需要脚本（例如原生构建）时设为 `true`，否则设为 `false`。
3. 运行 `pnpm check`、各项测试以及 `node deploy/dependency-audit.mjs audit`。更换后端的数据库相关库时，按上文检查数据库结构。
4. 在服务器上，升级程序的计划会列出更改将安装的内容：见[升级](Upgrade.zh-CN.md#依赖变更)。
