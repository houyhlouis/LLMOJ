# Docker 源

[English](Docker-Sources.md) | 简体中文

两个选项对应不同下载：**软件包安装源**用于安装 Docker Engine/buildx，**Docker Hub 镜像加速源**用于构建 rootfs 时取得容器基底镜像。默认使用 Docker 官方软件包源，并保留宿主机现有的镜像源配置；全新主机即使用官方 Docker Hub。

## 交互选择与命令行

完整模式的终端安装询问两个源，回车使用默认值。无人值守可指定：

```bash
sudo bash /tmp/llmoj-install.zh-CN.sh --repository houyhlouis/LLMOJ \
  --yes --docker-source https://YOUR_PACKAGE_MIRROR/docker-ce \
  --docker-mirrors https://YOUR_DOCKER_HUB_MIRROR
```

仅支持无凭据、查询参数的 HTTPS URL。多个镜像加速源用逗号分隔；上面的 URL 是占位示例，不是真实公共镜像源。

| 选项 | 输入格式 |
| --- | --- |
| `--docker-source` | 基础 URL，如 `https://download.docker.com`；脚本追加 `/linux/ubuntu` |
| `--docker-mirrors` | Docker Hub 拉取缓存入口，如 `https://mirror.example.com` |

软件包源不要再附加 `/linux/ubuntu`。自定义源必须提供对应 Ubuntu 版本的 Docker 签名软件包；GPG key 仍从 `https://download.docker.com/linux/ubuntu/gpg` 下载，保留官方信任密钥。此选项不替换已经安装的 Docker。见 [Docker 官方 Ubuntu 安装文档](https://docs.docker.com/engine/install/ubuntu/)。

## 配置行为

需要构建 rootfs 且选择了自定义镜像源时，脚本将 `registry-mirrors` 合并到 `/etc/docker/daemon.json`，保留其他配置。使用 `dockerd --validate` 验证候选文件，备份原文件为 `daemon.json.llmoj-backup-<UTC时间戳>`，再原子替换。JSON 或候选配置无效时停止，不替换原文件。配置变更后重启 Docker，可能中断已有容器。

镜像源留空不改 `daemon.json`。仅网页模式或复用已有 rootfs 会跳过 Docker 配置。安装重试必须使用原记录的 Docker 源选项；安装后换源应明确进行配置迁移。

rootfs 构建使用本机 Docker 默认 builder，让 daemon 的镜像配置生效。原版配方和固定基底 digest 保持不变。镜像加速源不负责 Ubuntu 快照、GitHub、npm 或语言工具链下载，也不能作为任意第三方 registry 的镜像。见 [Docker 镜像文档](https://docs.docker.com/docker-hub/image-library/mirror/)。

## 独立评测机

手动 [安装评测机](Remote-Judge.zh-CN.md) 时，先从合适的软件包源安装 Docker。需要镜像加速时使用同一配置助手：

```bash
sudo python3 deploy/docker-support.py --mirrors https://YOUR_DOCKER_HUB_MIRROR --configure
```

输出 `changed` 或 `unchanged`；只有 changed 时才需在构建前重启 Docker，unchanged 时确认 Docker 已启动即可。采用默认 builder 构建：

```bash
sudo systemctl restart docker  # 仅在镜像配置变更后执行。
sudo env BUILDX_BUILDER=default bash deploy/sandbox/build.sh build
```

回退时保留原 Docker 备份。助手不输出宿主机私有配置内容。
