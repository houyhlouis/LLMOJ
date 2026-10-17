# Docker 源

简体中文 | [English](Docker-Sources.md) | [Wiki 首页](Home.md)

安装器会通过 Docker 进行两类不同的下载，每类都可以选择下载源：

- **软件包源**：用于安装 Docker Engine 和 buildx；
- **Docker Hub 镜像加速源**：用于下载构建评测沙箱文件系统（rootfs）所需的基础镜像。

默认使用 Docker 官方软件包源，并且不修改服务器现有的 Docker Hub 设置；对新服务器来说就是使用官方 Docker Hub。

## 选择下载源

在终端中进行完整安装时，安装器会询问这两项，直接回车即使用默认值。无人值守安装时可以通过参数指定：

```bash
sudo bash /tmp/llmoj-install.zh-CN.sh --repository houyhlouis/LLMOJ \
  --yes --docker-source https://YOUR_PACKAGE_MIRROR/docker-ce \
  --docker-mirrors https://YOUR_DOCKER_HUB_MIRROR
```

上面的地址只是占位符，并不是真实的镜像源。请使用不含用户名、密码和查询参数的 HTTPS 地址；多个 Docker Hub 镜像源用逗号分隔。

| 参数 | 填写的地址 |
| --- | --- |
| `--docker-source` | 软件包源的基础地址，例如 `https://download.docker.com`。安装器会自动加上 `/linux/ubuntu`，不要自己加 |
| `--docker-mirrors` | Docker Hub 拉取缓存（镜像加速）地址，例如 `https://mirror.example.com` |

软件包源必须提供与你的 Ubuntu 版本对应、带有 Docker 签名的软件包。签名密钥仍从 `https://download.docker.com/linux/ubuntu/gpg` 下载，因此软件包会用 Docker 官方密钥校验。已经安装的 Docker 不会被替换。参见 [Docker 的 Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/)。

## 安装器会修改什么

需要构建 rootfs 且选择了 Docker Hub 镜像源时，安装器会把它们作为 `registry-mirrors` 写入 `/etc/docker/daemon.json`，并保留其他设置。它先用 `dockerd --validate` 检查新文件，把旧文件另存为 `daemon.json.llmoj-backup-<UTC 时间>`，再一次性替换；如果新配置无效，旧文件保持不变。之后会重启 Docker，可能中断正在运行的容器。

镜像源留空则不修改 `daemon.json`。仅网页安装或复用已有 rootfs 的安装不会改动 Docker。再次运行安装器时，请使用与第一次相同的下载源；安装完成后如需更换，请自行修改 Docker 配置。

rootfs 使用 Docker 的默认 builder 构建，以便镜像源设置生效；构建配方和固定的基础镜像版本不变。镜像源只加速 Docker Hub 镜像：Ubuntu 软件包、GitHub、npm 和各语言工具链的下载不经过它，其他镜像仓库也不经过它。参见 [Docker 镜像加速文档](https://docs.docker.com/docker-hub/image-library/mirror/)。

## 独立评测服务器

[手动安装评测服务器](Remote-Judge.zh-CN.md)时，先从适合该服务器的软件包源安装 Docker；如需 Docker Hub 镜像源，可以用安装器的辅助脚本设置：

```bash
sudo python3 deploy/docker-support.py --mirrors https://YOUR_DOCKER_HUB_MIRROR --configure
```

它会输出 `changed` 或 `unchanged`。输出 `changed` 时需要重启 Docker；否则只需确认 Docker 正在运行。然后用默认 builder 构建：

```bash
sudo systemctl restart docker  # 仅在输出 "changed" 时执行
sudo env BUILDX_BUILDER=default bash deploy/sandbox/build.sh build
```

请保留 `daemon.json` 的备份，以便需要时撤销修改。辅助脚本不会输出服务器配置的内容。
