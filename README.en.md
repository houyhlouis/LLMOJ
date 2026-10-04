# LLMOJ

[简体中文](README.md) | English

**LLMOJ is an online judge based on LibreOJ for programming contests, everyday practice and AI-assisted problem authoring.** It brings together problems, contests, judging and user permissions, with AI workflows for statement preparation, translation, source discovery and test-data generation.

[Documentation](wiki/Home.md) · [AI configuration](wiki/AI.md) · [Distributed judging](wiki/Distributed-Judging.md) · [Report an issue](https://github.com/houyhlouis/LLMOJ/issues)

## Features

### Problems, contests and permissions

- Chinese and English interfaces, a browser code editor, problem management, study lists, discussions and submission history.
- NOI, IOI and ICPC contest rules, with contest permissions, scoreboards and rejudging.
- Multiple users and groups, problem/discussion sharing, and permission controls for contests and administration.

### Multiple languages and judge nodes

- Languages including C/C++, Python and Java, with traditional, interactive, communication and output-only problems.
- LibreOJ's `simple-sandbox` and original rootfs recipe, with process, filesystem and network isolation and resource limits.
- Ordinary submissions can run on local or multiple remote judges. Each node connects with its own credentials and downloads test files on demand.

### AI-assisted authoring and learning

- **Statements and tutorials:** organize imported content, translate statements, and suggest tags, difficulty and tutorial drafts.
- **Source discovery:** combine search results and semantic checks to help identify a problem's original source.
- **Test data:** generate reference solutions, generators and validators; compile, run and check them in a sandbox, then save validated test files and judging configuration.
- **Task management:** view progress, cancel or retry jobs; problem writes recheck current permissions and the problem version.
- **Per-user configuration:** bring your own model and search services (Tavily/MCP). API keys are encrypted at rest; HTTP/HTTPS, public, private-network and loopback endpoints are supported.

Review AI-generated content. Executing reference solutions and test-data generation requires a local sandbox on the web node; see the deployment modes below and the [AI guide](wiki/AI.md).

## Quick installation

### Requirements

| Item | Requirement |
| --- | --- |
| Verified system | Ubuntu 24.04 amd64 on a regular VM or physical server |
| Memory | At least 3 GiB; 8 GiB recommended for compilation |
| Free disk | At least 30 GiB for a full installation, 40 GiB recommended; 10 GiB for web-only mode |
| System and network | systemd 254+, cgroup v2, and access to package repositories, GitHub and build dependency sources |

Run the English installation entry point in the server terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/houyhlouis/LLMOJ/main/install.sh -o /tmp/llmoj-install.sh && \
  sudo bash /tmp/llmoj-install.sh --repository houyhlouis/LLMOJ
```

The installer prompts for deployment mode, port, hostname, site name, installation directory and Docker sources, then installs dependencies, builds the application and configures services. Full mode also builds the judging rootfs; allow time for downloads and compilation on the first run.

The default directory is `/opt/LibreOJ`, with the site listening on `0.0.0.0:80` at `http://SERVER_IP`. See the [installation guide](wiki/Installation.md) for custom ports, mirrors, unattended installation and version pinning.

### After installation

1. **Sign in as administrator:** on success, the terminal prints `admin` and a random password. The server also saves `config/admin-credentials.json` under the installation directory (`/opt/LibreOJ` by default), readable only by root. Change the password after signing in; rerunning installation does not reset it.
2. **Start using the judge:** create users, assign permissions and add a problem. Submit a simple program to confirm judging, then create study lists or contests as needed.
3. **Configure AI:** users with AI configuration permission enter their service URL, model and API key, then test the connection. The project does not provide shared keys or prepaid services.

For public access, configure [HTTPS](wiki/HTTPS.md) and allow the chosen website port in your firewall or cloud security group. The installer does not change firewall rules.

## Deployment modes

| Mode | Components and purpose |
| --- | --- |
| `--role all` (default) | Web application, storage, local judging and AI execution; additional remote judges can handle ordinary submissions |
| `--role web` | Web application and storage, without a local rootfs; ordinary submissions require remote judges |

Use `all` on the web node for AI reference-solution validation and test-data generation. Remote ordinary judges do not automatically replace the local AI worker. See [distributed judging](wiki/Distributed-Judging.md) for architecture diagrams, node registration and setup.

## Documentation and development

| Documentation | Topics |
| --- | --- |
| [Installation](wiki/Installation.md) · [Docker sources](wiki/Docker-Sources.md) | Installer options, mirrors, service management and retries |
| [Distributed judging](wiki/Distributed-Judging.md) · [Remote judges](wiki/Remote-Judge.md) | Architecture, web/judge separation and node setup |
| [AI features](wiki/AI.md) · [HTTPS](wiki/HTTPS.md) | Model configuration, execution environment and encrypted site access |
| [Development](README-DEVELOPMENT.md) · [Source package](deploy/SOURCE-PACKAGE.md) | Builds, tests and source distribution scope |

Browse the full [English Wiki](wiki/Home.md) / [中文 Wiki](wiki/Home.zh-CN.md). 

## License and acknowledgements

LLMOJ is based on LibreOJ. The main source is [MIT](LICENSE), retaining upstream copyright and license notices. Thanks to LibreOJ and the contributors to its open-source dependencies. Third-party components and the rootfs recipe retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
