#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Translate installer-owned messages; package managers keep their own output.
translate() {
    local message=$1
    if [[ "${LLMOJ_INSTALL_LANG:-en}" != zh-CN ]]; then printf '%s' "$message"; return; fi
    case "$message" in
        'official/default') message='官方/现有默认配置' ;;
        '\nLLMOJ installation options (press Enter to keep defaults)\n') message='\nLLMOJ 安装选项（回车使用默认值）\n' ;;
        'Installation: all = website + local judge; web = website only') message='安装模式：all = 网页与本机评测；web = 仅网页' ;;
        'Website listener: 0.0.0.0 = public; 127.0.0.1 = local only') message='监听地址：0.0.0.0 = 公网；127.0.0.1 = 仅本机' ;;
        'HTTP port (80 needs no port suffix in the browser)') message='HTTP 端口（80 无需在浏览器地址加端口）' ;;
        'Installation directory') message='安装目录' ;;
        'Website name') message='站点名称' ;;
        'Browser hostname/IP (behind NAT, enter the real public IP or domain)') message='浏览器使用的域名/IP（NAT 环境请输入真实公网地址）' ;;
        'Docker package source base URL (HTTPS, official by default)') message='Docker 软件包源的基础 URL（HTTPS，默认官方源）' ;;
        'Docker Hub mirrors (comma-separated HTTPS URLs; blank keeps Docker defaults; changes restart Docker)') message='Docker Hub 镜像加速源（HTTPS，多个用逗号分隔；留空保留默认；修改会重启 Docker）' ;;
        'Directory: %s\nSite origin: %s\nListen address: %s:%s\nRole: %s\nSite name: %s\n') message='目录：%s\n访问地址：%s\n监听地址：%s:%s\n模式：%s\n站名：%s\n' ;;
        'Docker package source: %s/linux/ubuntu\nDocker Hub mirrors: %s\n') message='Docker 软件包源：%s/linux/ubuntu\nDocker Hub 镜像加速源：%s\n' ;;
        'Applying registry mirrors and restarting Docker (existing containers may be affected).\n') message='应用镜像加速源并重启 Docker（可能影响已有容器）。\n' ;;
        'Input ended; use --yes for non-interactive installation') message='输入结束；无人值守安装请使用 --yes' ;;
        'Interactive installation needs a terminal; download the script to a file and run it') message='交互安装需要终端；请先下载脚本，再运行该文件' ;;
        'Use an absolute prefix without spaces or special characters') message='安装目录必须是无空格或特殊字符的绝对路径' ;;
        'Choose a dedicated project directory') message='请选择专用于本项目的目录' ;;
        'Invalid public port') message='HTTP 端口无效' ;;
        'Run this installer with sudo') message='请使用 sudo 运行安装器' ;;
        'Run the script from the complete source tree') message='请在完整源码目录中运行安装器' ;;
        'Unsafe installer lock directory') message='安装锁目录不安全' ;;
        'Another LibreOJ installer is running') message='另一个 LLMOJ 安装器正在运行' ;;
        'Verify existing installation (retain credentials and configuration)') message='检查现有安装（保留凭据与配置）' ;;
        'Claim this installation directory') message='建立本实例的安装目录' ;;
        'Install distribution dependencies') message='安装系统依赖' ;;
        'Prepare source and pinned runtime tools') message='准备源码和固定版本运行工具' ;;
        'Build pinned MinIO from source and retain its AGPL license/source') message='构建固定版本 MinIO，保留其 AGPL 许可与源码' ;;
        'Install locked workspace dependencies and build the application') message='安装锁定依赖并构建项目' ;;
        'Build and validate original LibreOJ sandbox') message='构建并验证原版 LibreOJ 沙盒' ;;
        'Generate private configuration, permissions and systemd definitions') message='生成私有配置、目录权限和 systemd 单元' ;;
        'Initialize this instance database, Redis and object storage') message='初始化本实例的数据库、Redis 和对象存储' ;;
        'Start backend and create admin with all permissions') message='启动后端并创建全权限 admin' ;;
        'Verify real sandbox execution in a delegated cgroup') message='在委托的 cgroup 中验证实际沙盒执行' ;;
        'Start judge and web server, check health, enable automatic startup') message='启动评测与网页、检查状态并设置开机启动' ;;
        '\nSite URL: %s\n') message='\n站点地址：%s\n' ;;
        '\nInstallation complete. Site URL: %s\n') message='\n安装完成。站点地址：%s\n' ;;
        'Initial credentials: %s/config/admin-credentials.json (root only)\n') message='初始凭据：%s/config/admin-credentials.json（仅 root 可读）\n' ;;
        'Nginx listener: %s:%s. Internal services remain on loopback.\n') message='Nginx 监听：%s:%s。内部服务只监听回环地址。\n' ;;
        'Allow the selected website port in your firewall/cloud security group. TLS is configured separately.\n') message='请在防火墙/云安全组允许所选站点端口。TLS 需单独配置。\n' ;;
        'Use an SSH tunnel or an existing reverse proxy for remote access.\n') message='远程访问请使用 SSH 隧道或现有反向代理。\n' ;;
        'Web-only deployment: add remote judges using wiki/Distributed-Judging.md. Local AI sandbox actions are unavailable.\n') message='仅网页部署：请按 wiki/Distributed-Judging.zh-CN.md 添加远程评测机。本机 AI 程序执行功能不可用。\n' ;;
        '\nInstallation stopped at: %s\nNo runtime data was deleted. Correct the issue and rerun with the same arguments.\n') message='\n安装停在：%s\n运行数据已保留。解决问题后使用同一组选项重试。\n' ;;
        'Download checksum mismatch') message='下载文件校验值不匹配' ;;
        'Existing rootfs differs from the source recipe') message='已有 rootfs 与源码配方不匹配' ;;
        'Existing sandbox root must belong to root') message='已有沙盒根目录必须属于 root' ;;
        'runtime/node must be an installer symlink') message='runtime/node 必须是安装器创建的符号链接' ;;
        'Project MariaDB readiness timed out') message='项目 MariaDB 启动超时' ;;
        'Judge did not connect; inspect journalctl -u libreoj-judge.service') message='评测机未连接；请检查 journalctl -u libreoj-judge.service' ;;
        'Target already contains source without installation metadata; run its installer directly or choose a new directory') message='目标目录已有源码但无安装元数据；请直接运行其中的安装器，或选择新目录' ;;
        'testlib source is missing; use a full source archive or clone with submodules') message='缺少 testlib 源码；请使用完整源码包或初始化子模块' ;;
        'Existing Docker has no buildx plugin; install its matching buildx package and retry') message='已有 Docker 缺少 buildx；请安装匹配的 buildx 软件包后重试' ;;
        'Missing value for '*) message="缺少参数值：${message#Missing value for }" ;;
        'Unknown argument: '*) message="未知参数：${message#Unknown argument: }" ;;
        'Service readiness timeout: '*) message="服务启动超时：${message#Service readiness timeout: }" ;;
    esac
    printf '%s' "$message"
}
say() { local format; format="$(translate "$1")"; shift; printf "$format" "$@"; }
