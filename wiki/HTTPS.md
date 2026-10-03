# HTTPS and reverse proxies

English | [简体中文](HTTPS.zh-CN.md)

Default installation serves HTTP on `0.0.0.0:80`. Configure certificates/proxying separately before sending admin passwords, AI keys or judge credentials over the public internet.

## Caddy in front of the project Nginx

Point the domain's A record to the server's public IP and allow TCP 80/443 in the firewall/cloud security group. Install LLMOJ on loopback:

```bash
sudo bash /tmp/llmoj-install.sh --repository houyhlouis/LLMOJ \
  --yes --listen 127.0.0.1 --port 8080 --public-url https://oj.example.com
```

Add `--role web` for a web-only node. The public URL must match the final HTTPS origin so signed downloads and configured callbacks use a reachable address.

Follow [Caddy's installation guide](https://caddyserver.com/docs/install) for its systemd package. Set `/etc/caddy/Caddyfile`:

```caddyfile
oj.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
curl -I https://oj.example.com/
```

With DNS/ports available, Caddy obtains and renews certificates and redirects HTTP to HTTPS. See [automatic HTTPS](https://caddyserver.com/docs/quick-starts/https) and [reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). This example does not enable request access logs.

## Existing proxy

Preserve WebSocket Upgrade and long connections for `/api/socket`. Forward `/api/`, `/socket.io/`, `/storage/` and frontend routes. Keep storage signature query parameters; let the project Nginx restore MinIO's signed internal Host rather than exposing MinIO directly.

Judge authentication uses a WebSocket query key. Built-in Nginx disables access logging on that path and records query-free URIs elsewhere. Avoid query strings in the outer proxy's logs too. Do not enable debugging that records complete authenticated URLs.

Database, Redis, MinIO, backend and metrics remain local. Changing an installed origin/port/listener is a migration: back up private config, update public backend/storage URLs, Nginx and any local download override together, then validate and restart. The installer refuses to overwrite an existing instance with different options.
