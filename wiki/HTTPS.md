# HTTPS and reverse proxies

[简体中文](HTTPS.zh-CN.md) | English | [Wiki home](Home.en.md)

A default installation serves plain HTTP on port 80 of every address (`0.0.0.0:80`). Set up HTTPS before anyone sends administrator passwords, AI keys or judge keys over the internet. [Passkeys](Two-Factor-Sign-In.md) also need HTTPS.

## Caddy in front of LLMOJ

This is the simplest way to set up HTTPS on a new server.

1. Point the domain's DNS A record at the server's public IP address, and allow TCP ports 80 and 443 in the firewall and the cloud provider's security group.
2. Install LLMOJ so that it listens only on the server itself, with the final HTTPS address as its public URL:

   ```bash
   sudo bash /tmp/llmoj-install.sh --repository houyhlouis/LLMOJ \
     --yes --listen 127.0.0.1 --port 8080 --public-url https://oj.example.com
   ```

   Add `--role web` for a server without a judge. The public URL must be exactly the address people use, because judge downloads and callbacks are built from it.
3. Install Caddy's systemd package as described in [Caddy's installation guide](https://caddyserver.com/docs/install), and set `/etc/caddy/Caddyfile` to:

   ```caddyfile
   oj.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```
4. Check the file, start Caddy and test the site:

   ```bash
   sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   sudo systemctl enable --now caddy
   sudo systemctl reload caddy
   curl -I https://oj.example.com/
   ```

Caddy obtains and renews the certificate itself, redirects HTTP to HTTPS and passes WebSocket connections through. See Caddy's [automatic HTTPS](https://caddyserver.com/docs/quick-starts/https) and [reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) documentation. This configuration doesn't log requests.

## Using another proxy

If you already have a proxy, make it:

- pass WebSocket upgrades and keep long-lived connections open for `/api/socket`;
- forward `/api/`, `/socket.io/`, `/storage/` and every other path to LLMOJ's Nginx;
- keep the query string of `/storage/` requests, which carries the download signature. Send these requests to LLMOJ's Nginx, which passes them on to the storage server correctly; don't expose the storage server (MinIO) directly.

Judges send their key in the query string of their WebSocket connection. LLMOJ's Nginx doesn't log that path, and logs other paths without query strings. Configure your proxy not to log query strings either, and don't turn on debug logging that records full URLs.

## Changing the address later

The database, Redis, MinIO, the backend and its metrics stay reachable only from the server itself. Changing the public address, port or listening address of an existing installation means changing several settings together: back up the private configuration, then update the backend's public URL, the storage download address, Nginx and any local download override at the same time, check the configuration and restart. The installer won't reinstall over an existing installation with different options.
