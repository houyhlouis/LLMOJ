# 发布源码与 Wiki

简体中文 | [English](Publishing.md) | [Wiki 首页](Home.md)

以下步骤供仓库维护者使用。LLMOJ 的打包工具不会创建仓库、推送 Git 或发布 Release，这些需要你自己完成。

提交到仓库不会改变正在运行的站点。要在服务器上安装新版本，请在修改上传到 GitHub 之后使用[升级器](Upgrade.zh-CN.md)。

## 用 GitHub Desktop 应用更新包

只含修改文件的更新包需要覆盖到完整的仓库副本上：

1. 在 GitHub Desktop 中打开 `houyhlouis/LLMOJ` 的本地仓库，先获取最新的远程修改。
2. 把更新包解压到仓库根目录，保留其中的路径（`apps`、`packages`、`deploy`、`wiki`、`.github` 等）。更新包中没有的文件保持不变。
3. 在 **Changes** 中确认只修改了预期的文件，填写摘要、提交，然后 **Push origin**。不要提交 ZIP 文件本身，也不要提交任何服务器配置。
4. 等 GitHub Actions 检查通过后再升级服务器。

更新包不是完整的源码，不能单独安装。

## 发布 GitHub Wiki

仓库中的 `wiki/` 目录可以在 GitHub 上作为普通文档阅读。**Wiki** 标签页则是另一个仓库 `https://github.com/houyhlouis/LLMOJ.wiki.git`，向主仓库提交不会更新它。

第一次使用时，在仓库的 **Settings** 中启用 Wiki，并在 GitHub 上创建第一个页面，然后克隆：

```bash
git clone https://github.com/houyhlouis/LLMOJ.wiki.git ~/llmoj-wiki
```

（在 GitHub Desktop 中使用 **File → Clone Repository → URL**。如果 Desktop 不接受 Wiki 地址，请用上面的命令克隆，再通过 **File → Add Local Repository** 添加。）

发布时，把主仓库中的页面导出到 Wiki 仓库，检查修改后推送：

```bash
cd /path/to/LLMOJ
python3 deploy/export-wiki.py --repository houyhlouis/LLMOJ --output ~/llmoj-wiki
cd ~/llmoj-wiki
git diff
git add -- '*.md'
git commit -m "Update documentation"
git push
```

导出脚本只写入 Markdown 文件：不运行 Git，也不联网。它会把页面之间的链接转换为 Wiki 链接，并生成中文在前的双语侧栏 `_Sidebar.md`。`Home` 是中文首页，`Home.en` 是英文首页；保留 `Home.zh-CN` 是为了让旧链接仍然可用。同名页面会被替换，因此推送前请检查 `git diff`；只存在于 Wiki 中的页面会保留。

如果更新包中已经包含导出好的 Wiki 页面，请把其导出目录**内部**的 `.md` 文件复制到 Wiki 仓库根目录，不要放进 `wiki/` 子目录，也不要覆盖其中的 `.git`。

参见 GitHub 关于[本地编辑 Wiki](https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages) 和[用 GitHub Desktop 克隆](https://docs.github.com/en/desktop/adding-and-cloning-repositories/cloning-and-forking-repositories-from-github-desktop)的说明。

## 创建版本标签

创建标签之前，请在全新的 Ubuntu 服务器上测试两个安装器（`install.sh` 和 `install.zh-CN.sh`）：`all` 和 `web` 模式、自定义端口、默认和自定义 Docker 源、第一个管理员以及远程评测机。然后：

```bash
git tag v0.1.0
git push origin v0.1.0
```

版本号只是示例。安装某个版本时，下载地址和 `--ref` 都应使用该标签。

## 从源码包创建新仓库

如果要从已安装的副本在新仓库中发布 LLMOJ，请先生成干净的源码包。它只包含 Git 跟踪的文件，不包括旧的 `.git`、`runtime`、`data`、日志、真实配置或密钥。该工具不会覆盖已有的压缩包，必要时请换一个文件名。

```bash
cd /opt/LLMOJ
python3 deploy/prepare-github.py --archive release/llmoj-source.tar.gz
sha256sum release/llmoj-source.tar.gz
mkdir -p ~/llmoj-publish
tar -xzf release/llmoj-source.tar.gz -C ~/llmoj-publish
cd ~/llmoj-publish/LibreOJ
```

压缩包中是一个 `LibreOJ/` 目录。testlib 及其许可证作为普通文件包含在内：请原样提交，这样 GitHub 的下载快照可以直接安装；不要把这个目录改回子模块链接。`.gitmodules` 仍然记录 testlib 的来源。

在 GitHub 上创建一个空的**公开**仓库，不要自动生成 README 或许可证（匿名一键安装需要公开仓库）。把两份 README 和 Wiki 命令中的 `houyhlouis/LLMOJ` 替换为你的仓库路径，然后推送：

```bash
git init -b main
git add .
git diff --cached --stat
git commit -m "Initial LLMOJ source release"
git remote add origin https://github.com/houyhlouis/LLMOJ.git
git push -u origin main
```

请通过 GitHub CLI、凭据管理器或个人访问令牌登录；不要把令牌写进远程地址、脚本或文档。

## 许可证

LLMOJ 自身的源码采用 MIT 许可证，原版沙箱镜像配方采用 Unlicense。MinIO、数据库、编译器、字体等组件保留各自的许可证：发布本仓库不会改变它们的许可证，请保留所有许可证和版权声明。

沙箱镜像在安装时于每台服务器上构建；源码中不包含构建好的镜像、NOI Linux 镜像或站点数据。如果要把构建好的程序或沙箱镜像附加到 Release，请先检查各组件的声明、源码提供义务和再分发条款。
