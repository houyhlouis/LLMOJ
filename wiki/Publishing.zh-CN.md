# 发布源码、版本与 GitHub Wiki

[English](Publishing.md) | 简体中文

以下步骤由仓库所有者执行。本地打包工具不会创建仓库、推送 Git 或发布 Release。项目名称为 LLMOJ；默认 README 为中文，英文版位于 `README.en.md`；Wiki 提供中英文版本。

## 1. 创建干净发布目录

在原项目目录生成源码包；若目标归档已存在，换一个文件名，打包器不会覆盖：

```bash
cd /opt/LibreOJ
python3 deploy/prepare-github.py --archive release/llmoj-source.tar.gz
sha256sum release/llmoj-source.tar.gz
mkdir -p ~/llmoj-publish
tar -xzf release/llmoj-source.tar.gz -C ~/llmoj-publish
cd ~/llmoj-publish/LibreOJ
```

压缩包内含 `LibreOJ/` 源码目录。不要直接推送原部署目录的旧 `.git` 历史，也不要复制 `runtime/`、`data/`、日志、真实配置或 API Key。

源码包把原子模块 testlib 的源码与 LICENSE 作为普通文件携带。新仓库提交时保留这些文件，GitHub 下载快照才可直接安装；不要重新把这个目录提交为只包含引用的 gitlink。`.gitmodules` 保留原上游来源，目录内容已随新仓库提交。

## 2. 创建公开 GitHub 仓库并推送

在 GitHub 创建空仓库，选 Public，先不要自动生成 README 或 LICENSE。主体已有 MIT LICENSE，保留原作者版权与第三方声明。将中英文 README 和 Wiki 的所有 `houyhlouis/LLMOJ` 替换为实际路径；同样替换 Wiki 中供用户复制的安装命令。

```bash
git init -b main
git add .
git diff --cached --stat
git commit -m "Initial source release"
git remote add origin https://github.com/houyhlouis/LLMOJ.git
git push -u origin main
```

HTTPS 推送使用你本机已配置的 GitHub CLI、凭据管理器或个人访问令牌；不要把令牌写进 remote URL、安装脚本或文档。GitHub 私有仓库不能提供本教程的匿名一键下载；先 private 审核也可以，转 public 后再启用匿名安装说明。

从全新 Ubuntu 服务器验证 README 的一键命令和管理员初始化，分别验证 `--role all`、`--role web`、自定义端口及独立评测机，再创建版本标签：

```bash
git tag v0.1.0
git push origin v0.1.0
```

标签只是示例，按实际发布版本调整。推荐用户把下载脚本的 URL 中 `main` 和 `--ref` 都换成同一发布标签。已在 Ubuntu 24.04 amd64 上完成部署及基础功能验证；发布前仍应验证对应版本和部署组合，真实多机部署需单独验收。

## 3. 同步 GitHub Wiki

仓库里的 `wiki/*.md` 上传后能作为普通文档阅读，GitHub Wiki 是另外的 Git 仓库。先在仓库 Settings 启用 Wiki，并在网页创建第一个 Home 页面，再克隆。操作依据 [GitHub 官方 Wiki 文档](https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages)。

```bash
cd ~/llmoj-publish/LibreOJ
git clone https://github.com/houyhlouis/LLMOJ.wiki.git ~/llmoj-wiki
python3 deploy/export-wiki.py --repository houyhlouis/LLMOJ --output ~/llmoj-wiki
cd ~/llmoj-wiki
git diff
git add -- '*.md'
git commit -m "Add deployment documentation"
git push
```

导出脚本只写本地 Markdown，不执行 Git 命令或联网；它把仓库内 `.md` 链接转换成对应 GitHub Wiki 页面链接，并生成中文在前的双语侧栏。`Home.md` 是中文首页，`Home.en.md` 是英文首页，`Home.zh-CN.md` 保留为旧链接兼容入口。已有同名 Wiki 页面会被这些文档替换，因此先检查 `git diff`。后续更新用同样流程。

## 使用 GitHub Desktop 更新已有文档

如果拿到的是只包含文档的更新包，不需要重新发布源码：

1. 在 GitHub Desktop 打开 `houyhlouis/LLMOJ` 的本地仓库，先同步远程更新。
2. 把包中的 `wiki/` 内容合并到仓库同名目录；保留包中未包含的原有页面。查看 Changes，确认只包含预期 Markdown 文档，再填写 summary、commit 并 Push origin。压缩包、校验记录和部署机私密配置不应一起提交。
3. 这只更新 Code 页中的文档。若还要更新 GitHub 的 **Wiki 标签页**，需要单独处理 `https://github.com/houyhlouis/LLMOJ.wiki.git`：先在 GitHub 网页创建首个 Wiki 页面，再在 Desktop 的 File → Clone Repository → URL 输入该地址。界面拒绝特殊 Wiki 地址时，可按上面的命令克隆，再通过 File → Add Local Repository 加入 Desktop。
4. 在源码仓库运行上节 `export-wiki.py`，将 `--output` 指向 Wiki 仓库目录。检查 Wiki 仓库的 Changes，再单独 commit/push。也可以使用更新包提供的已导出页面，复制其目录**内部**的 `.md` 文件到 Wiki 仓库根目录；不要嵌套一层 `wiki/`。

两个仓库的提交相互独立。源码文档应保留相对 `.md` 链接，Wiki 导出版使用页面 URL 并带 `_Sidebar.md`；不要把两套文件相互覆盖。导出范围内的同名页面会更新，人工额外页面需自行保留。

操作参考：[GitHub Wiki 本地编辑](https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages)、[GitHub Desktop 克隆仓库](https://docs.github.com/en/desktop/adding-and-cloning-repositories/cloning-and-forking-repositories-from-github-desktop)。

## 4. 分发范围与许可

主体源码为 MIT，原版 rootfs 配方为 Unlicense。MinIO、数据库、编译器、字体和其他组件各自适用原许可。发布此源码仓库不会让这些第三方软件统一变成 MIT；不要删掉 LICENSE 或第三方版权说明。

安装器在服务器下载并构建 rootfs，源码包不含完整 rootfs、NOI Linux ISO 或运行数据。如果以后上传二进制或 rootfs 到 Release，需要另行检查其版权材料、适用源码提供义务和各组件再分发条款。
