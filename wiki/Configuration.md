# Configuration overview

[简体中文](Configuration.zh-CN.md) | English | [Wiki home](Home.en.md)

This page tells you where each kind of setting lives and how to make a change take effect. Paths assume the default installation directory `/opt/LLMOJ`; if you installed elsewhere with `--prefix`, use your own directory everywhere.

## Where settings live

| Page | What it covers |
| --- | --- |
| [Installation](Installation.md) | The installer and its options |
| [Backend configuration](Backend-Configuration.md) | `config/backend.yaml`: accounts, security, database, mail, storage, contests and display |
| [Registration approval](Registration-Approval.md) | The registration mode set in **Site management**, its default in `backend.yaml`, and reviewers |
| [Two-factor sign-in](Two-Factor-Sign-In.md) | Authenticator codes and passkeys, which users set up themselves, and the `two-factor.key` file |
| [Judge configuration](Judge-Configuration.md) | `config/judge.yaml`, resizing for more or fewer CPUs, services and checks |
| [AI](AI.md) | AI models, web search, permissions and jobs, set by each user in the site |
| [AI environment](AI-Environment.md) | AI directories, keys and environment variables on the server |
| [Environment variables](Environment.md) | Environment variables for running, installing and building, and maintenance script options |
| [Frontend configuration](Frontend-Configuration.md) | Building the frontend and optional CDN settings |
| [Operations](Operations-Configuration.md) | Nginx, MariaDB, Redis, MinIO, systemd, and changes after installation |

## Defaults, examples and your own values

- **Built-in defaults** are what the code uses when a setting is missing. Most settings in `backend.yaml` and `judge.yaml` have no built-in default, so deleting a line doesn't bring back the value from an example.
- **Examples** in the repository (`*.example`) may contain values meant for another site.
- **Installer values** are calculated during the first installation from the directory, ports, CPUs and memory. Running the installer again keeps the existing files.
- **What's actually in effect** is your configuration files together with the systemd units and their drop-in files. The registration mode saved in **Site management** overrides the one in `backend.yaml`, and AI settings are stored per user.

## Making a change take effect

| What you changed | What to do |
| --- | --- |
| `config/backend.yaml` | Check that the YAML is valid, restart `libreoj-backend` and refresh the browser. A registration mode saved in **Site management** still takes precedence. |
| Registration mode in **Site management** | Nothing: it applies as soon as it's saved. See [Registration approval](Registration-Approval.md). |
| `config/judge.yaml` | Follow [Judge configuration](Judge-Configuration.md): let running judging finish first. Changes to slots, CPUs or directories also need new systemd units. |
| systemd environment, resource limits or drop-ins | Run `systemctl daemon-reload`, then restart the service. `daemon-reload` alone doesn't restart anything. |
| `config/nginx.conf` | Check it with `nginx -t`, then reload Nginx. Keep the domain and the storage download address consistent. |
| MariaDB, Redis or MinIO | Restart the service at a quiet time and check that the backend can still use it. |
| Frontend build settings or static files | Rebuild, copy the result to the directory Nginx serves, and refresh the browser. |
| AI models, search and permissions | Save them in the site. Running jobs check permissions again as they go; see [AI](AI.md). |

The installer's options are for the first installation only. Running the installer again with a different `--judge-slots`, `--port` or `--public-url` doesn't reconfigure the site: it may refuse the new values, and it keeps the existing YAML files. Don't delete the installation state, `secrets.json`, the AI master key or data to get round this.

## Common changes

- More or fewer CPUs or memory: [resize the judge](Judge-Configuration.md).
- Site name, ports, domain, mail, upload limits or service memory: [Operations](Operations-Configuration.md).
- AI models, Tavily or MCP: [AI](AI.md).

Back up the database, file storage, configuration and AI keys together: the source code alone can't restore a site. Never put real passwords or keys in the wiki or on GitHub.
