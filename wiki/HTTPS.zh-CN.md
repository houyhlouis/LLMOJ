# HTTPS 与反向代理

[English](HTTPS.md) | 简体中文

默认安装提供 `0.0.0.0:80` 的 HTTP 站点。域名 HTTPS 需另外配置证书和代理；公网传输管理员密码、AI Key 和远程评测密钥前应完成此步骤。

## 新服务器示例：Caddy 在前，项目 Nginx 在后

先将域名 A 记录指向服务器公网 IP，在防火墙和云安全组允许 TCP 80、443。项目安装时把 Nginx 放在回环地址：

```bash
sudo bash /tmp/llmoj-install.zh-CN.sh --repository houyhlouis/LLMOJ \
  --yes --listen 127.0.0.1 --port 8080 --public-url https://oj.example.com
```

若只部署网页，在命令后加 `--role web`。`--public-url` 必须是浏览器最终访问的 HTTPS origin，使评测文件签名地址、OAuth 回调等使用正确地址。

按 [Caddy 官方安装说明](https://caddyserver.com/docs/install) 安装 systemd 版本，并将 `/etc/caddy/Caddyfile` 设置为：

```caddyfile
oj.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

应用配置：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
curl -I https://oj.example.com/
```

满足 DNS 与端口条件时，Caddy 会申请和续期证书，并把 HTTP 重定向到 HTTPS；参见 [官方 HTTPS 指南](https://caddyserver.com/docs/quick-starts/https)。反向代理会处理 WebSocket 升级，参见 [reverse_proxy 文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。本示例未开启请求访问日志。

## 使用现有代理

保留 `/api/socket` 的 WebSocket Upgrade，支持长连接，并完整转发 `/api/`、`/socket.io/`、`/storage/` 和前端路径。`/storage/` 的签名参数必须保留；交由项目内置 Nginx 还原 MinIO 的签名 Host，不直接改接到公开 MinIO。

评测鉴权 key 位于 WebSocket 查询参数中。内置 Nginx 对该路径关闭访问日志，并对其他路径仅记录无查询串的 URI；外层代理也应避免记录查询串。不要开启可能记录完整请求 URL 的调试日志。

数据库、Redis、MinIO、后端和指标端口继续仅回环监听。修改已安装站点的 origin、端口或监听地址属于配置迁移：先备份私有配置，统一修改后端公开地址、MinIO 对 judge 的下载地址、Nginx 与必要的本机下载覆盖地址，验证再重启。安装器会拒绝把已有实例直接当作不同参数的新实例覆盖。
