# HTTPS 与反向代理

简体中文 | [English](HTTPS.md) | [Wiki 首页](Home.md)

默认安装在所有地址的 80 端口（`0.0.0.0:80`）提供普通 HTTP。在通过公网传输管理员密码、AI Key 或评测机密钥之前，请先配置 HTTPS。[通行密钥](Two-Factor-Sign-In.zh-CN.md)也需要 HTTPS。

## 在 LLMOJ 前使用 Caddy

这是在新服务器上配置 HTTPS 最简单的方法。

1. 把域名的 DNS A 记录指向服务器的公网 IP，并在防火墙和云服务商的安全组中放行 TCP 80 和 443 端口。
2. 安装 LLMOJ 时让它只在本机监听，并把最终的 HTTPS 地址作为公开地址：

   ```bash
   sudo bash /tmp/llmoj-install.zh-CN.sh --repository houyhlouis/LLMOJ \
     --yes --listen 127.0.0.1 --port 8080 --public-url https://oj.example.com
   ```

   不需要评测机的服务器加上 `--role web`。公开地址必须与用户访问的地址完全一致，因为评测文件下载和回调地址都由它生成。
3. 按 [Caddy 安装说明](https://caddyserver.com/docs/install) 安装 systemd 版本，并把 `/etc/caddy/Caddyfile` 设置为：

   ```caddyfile
   oj.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```
4. 检查配置、启动 Caddy 并测试网站：

   ```bash
   sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   sudo systemctl enable --now caddy
   sudo systemctl reload caddy
   curl -I https://oj.example.com/
   ```

Caddy 会自动申请和续期证书，把 HTTP 重定向到 HTTPS，并转发 WebSocket 连接。参见 Caddy 的 [自动 HTTPS](https://caddyserver.com/docs/quick-starts/https) 和 [reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) 文档。此配置不记录访问日志。

## 使用其他代理

如果已有反向代理，请确保它：

- 为 `/api/socket` 转发 WebSocket 升级并保持长连接；
- 把 `/api/`、`/socket.io/`、`/storage/` 和其他所有路径转发到 LLMOJ 的 Nginx；
- 保留 `/storage/` 请求的查询参数，其中包含下载签名。这些请求要交给 LLMOJ 的 Nginx，由它正确转发给存储服务；不要直接公开存储服务（MinIO）。

评测机通过 WebSocket 连接的查询参数发送密钥。LLMOJ 的 Nginx 不记录这个路径的日志，其他路径也只记录不含查询参数的地址。请让你的代理同样不记录查询参数，也不要开启会记录完整 URL 的调试日志。

## 以后修改地址

数据库、Redis、MinIO、后端及其监控指标都只能从本机访问。修改已安装站点的公开地址、端口或监听地址时，需要同时修改多项设置：先备份私有配置，再一起修改后端的公开地址、存储下载地址、Nginx 以及本机下载地址覆盖（如有），检查配置后重启。安装器不会用不同的参数覆盖已有安装。
