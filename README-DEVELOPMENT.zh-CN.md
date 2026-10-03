# 开发与构建

[English](README-DEVELOPMENT.md) | 简体中文

项目基于 LibreOJ，主体采用 MIT；各组件原声明必须保留。项目介绍见 [README](README.zh-CN.md)，部署见 [Wiki](wiki/Home.zh-CN.md)。

## 工具链

- Node.js 至少 22.13；一键安装固定使用 24.21.0。
- 使用 `package.json` 指定的 pnpm 11.13.0。
- Linux amd64、CMake、C++ 编译器、libfmt；实际沙盒执行还需 namespaces 与 cgroup v2。

```bash
pnpm install --frozen-lockfile
pnpm build:artifacts
pnpm --filter simple-sandbox build
pnpm build:native
pnpm build
pnpm check-types
```

源码归档包含 testlib；仅在 Git 子模块内容缺失时执行 `git submodule update --init --recursive`。

## 运行配置

`config/*.example` 是模板。实际配置、API Key、数据库、依赖、rootfs 和构建产物不进入源码仓库。安装器生成这些文件，默认站点监听 `0.0.0.0:80`；后端与存储仅监听本机。

`HYHOJ_*` 是二次开发早期采用的内部环境变量名，暂时保留以兼容已有功能代码；它们不控制站点展示名称。新部署服务使用 `libreoj-*`，站名由 `--site-name` / `OJ_SITE_NAME` 设置。

原版 rootfs 构建及验证见 [沙盒说明](deploy/sandbox/README.md)。Docker 用于构建，不参与每次提交的原生沙盒执行。

## 测试与打包

```bash
node --test --test-concurrency=1 apps/backend/src/ai/*.test.cjs
python3 deploy/test/github-entry.test.py
sudo python3 deploy/test/install-support.test.py
sudo python3 deploy/test/install-network.test.py
sudo python3 deploy/test/judge-config.test.py
python3 deploy/prepare-github.py --archive release/llmoj-source.tar.gz
```

数据库及浏览器集成测试应使用一次性实例，具体约束见 [AI 说明](apps/backend/src/ai/README.md)。不要把生产数据库或会话作为测试 fixture。打包器仅检查并创建本地归档，不提交、推送或发布到 GitHub。
