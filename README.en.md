# LLMOJ

[简体中文](README.md) | English

**LLMOJ is an online judge based on LibreOJ, built for programming contests, everyday practice and AI-assisted problem setting.** It combines a problem archive, contests, judging and permission management, with AI tools to tidy up statements, translate them, find a problem's original source and generate test data.

[Repository](https://github.com/houyhlouis/LLMOJ) · [Documentation](wiki/Home.en.md) · [AI configuration](wiki/AI.md) · [Distributed judging](wiki/Distributed-Judging.md) · [Report an issue](https://github.com/houyhlouis/LLMOJ/issues)

## Features

### Problems, contests and community

- Chinese and English interfaces and an in-browser code editor; problem management, study lists, discussions and submission history.
- [Contest rules](wiki/Contest-Rules.md): NOI / OI, IOI, ICPC and Strict IOI (each subtask counts the best of all submissions), with scoreboards and rejudging.
- Users, groups and fine-grained permissions: problems and discussions can be shared individually, and contest and administration rights are granted separately.
- [Private teams](wiki/Teams.md): join a team by its ID under **My teams** on your profile; there is no public team list. Teams have groups and roles, problems, contests, assignments, discussions and shared files (10 GiB in total; large files upload in parts).
- [Solutions](wiki/Solutions.md): read and write them on the problem page, or have AI draft one.
- [Hacks](wiki/Hacks.md): challenge a submission with a counterexample from its detail page. A successful hack voids the submission's score and keeps the evidence.
- [Self Eval](wiki/Self-Evaluation.md): an option for NOI / OI contests. Contestants check their programs against hidden pretests that don't count toward their score, by default up to 30 times per contest.
- [Fake moderation](wiki/Submission-Moderation.md): set a cheating submission's score to zero and update the statistics, while keeping its code and judging record as evidence.
- Registration can be open, [approval-based](wiki/Registration-Approval.md) or closed, switched in **Site management** and effective immediately; reviewing can be delegated to other users.
- [Two-factor sign-in](wiki/Two-Factor-Sign-In.md) with authenticator apps and passkeys.

### Judging

- 12 languages, including C/C++, Python and Java; traditional, interactive, communication and output-only problems.
- A sandbox based on LibreOJ's `simple-sandbox` and its original rootfs: separate process, filesystem and network environments, cgroup resource limits, and a filter that refuses dangerous system calls.
- Judging tasks are kept in the database, so restarting the backend or a judge loses no submission. Editing a problem doesn't change how queued submissions are judged, and a rejudge keeps the earlier result.
- Judge locally, or connect several [remote judge machines](wiki/Distributed-Judging.md). Each has its own key, and can be drained (sent no new tasks) from the **Judge Machine** page for maintenance.

### AI-assisted problem setting

- **Statements and solutions:** tidy up imported statements, translate them, suggest tags and difficulty, and draft solutions.
- **Finding sources:** combine search results with semantic comparison to help find a problem's original source.
- **Test data:** for traditional problems, at least 64 small cases are first checked against an independent reference algorithm, then all the data is cross-checked with a second correct solution, and prepared wrong or too-slow programs must actually fail on it. Only then is the data installed, together with a validation report. Interactive and communication problems are checked by simulating their protocol.
- **Job management:** follow progress, cancel or retry; before writing to a problem, AI jobs check the permissions again and whether the problem has changed.
- **Your own services:** each user enters their own model and search services (Tavily / MCP); API keys are stored encrypted. Private-network and local addresses are available only to site administrators, unless the server administrator allows them with `HYHOJ_AI_PRIVATE_HOSTS`.
- **Site limits:** administrators can pause AI for the whole site, and limit each account's tokens and requests per 24 hours, each job's requests, and how many AI requests run at once. Every request is checked before it's sent.

Review everything AI generates. Validating reference solutions and generating test data run in a local sandbox on the web server; see the [AI guide](wiki/AI.md).

## Installation

### Requirements

| Item | Requirement |
| --- | --- |
| System | Ubuntu 24.04 amd64 (tested), on a virtual machine or physical server |
| CPU and memory | At least 2 logical CPUs; 256 MiB of RAM per judge execution slot; 8 GiB recommended for building |
| Disk | At least 30 GiB free for a full installation (40 GiB recommended), 10 GiB for the website only |
| Other | systemd 254 or later, cgroup v2, and access to package repositories, GitHub and the build dependencies' download sources |

Run the English installation script on the server:

```bash
curl -fsSL https://raw.githubusercontent.com/houyhlouis/LLMOJ/main/install.sh -o /tmp/llmoj-install.sh && \
  sudo bash /tmp/llmoj-install.sh --repository houyhlouis/LLMOJ
```

The script asks for the deployment mode, port, domain, site name, installation directory and Docker sources, then installs dependencies, builds LLMOJ and sets up its services. A full installation also builds the rootfs used for judging, so the first run takes a while.

By default LLMOJ is installed in `/opt/LLMOJ` and listens on `0.0.0.0:80`; open `http://SERVER_IP` in a browser. Custom ports, mirrors, unattended installation and pinned versions are covered in the [installation guide](wiki/Installation.md).

A full installation asks how many judge execution slots to use (how many programs can be judged at the same time). The default is the smaller of "logical CPUs minus 1" and "RAM in MiB ÷ 256": for example, 2 slots with 3 CPUs and 512 MiB. With a single CPU or less than 256 MiB of RAM there is no local judging; install the website only. To change the number of slots later, use the [resize script](wiki/Judge-Configuration.md).

### After installation

1. **Sign in as administrator:** when the installation finishes, the terminal shows the user `admin` and a random password. They are also saved in `config/admin-credentials.json` in the installation directory, readable only by root. Change the password after signing in; running the installer again doesn't reset it.
2. **Start using it:** create users, assign permissions and add a problem. Submit a simple program to check that judging works, then create study lists or contests.
3. **Set up AI:** users with permission to configure AI enter their own service URL, model and API key, and test the connection. LLMOJ doesn't provide shared keys or paid services.

For public access, set up [HTTPS](wiki/HTTPS.md) and open the website's port in your firewall or cloud security group; the installer doesn't change firewall rules.

## Upgrading

An installation made with the installation script can be upgraded with:

```bash
curl -fsSL https://raw.githubusercontent.com/houyhlouis/LLMOJ/main/upgrade.sh -o /tmp/llmoj-upgrade.sh && \
  sudo bash /tmp/llmoj-upgrade.sh --prefix /opt/LLMOJ
```

The script checks compatibility, builds the new version in a separate directory, makes a backup, and switches versions only after you confirm. Accounts, problems, API keys, configuration and judge slots are kept. Add `--plan` to check without changing anything. Before upgrading, pause new submissions and wait until judging on all judge machines and AI jobs have finished. Incompatible dependency, runtime or database changes are refused, so not every old version can be upgraded directly. Options and rollback are described in the [upgrade guide](wiki/Upgrade.md); for the database changes each feature brings, see [Feature upgrades](wiki/Community-Upgrade.md).

## Deployment modes

| Mode | Contents |
| --- | --- |
| `--role all` (default) | Website, storage, local judging and the AI execution environment; remote judge machines can be added |
| `--role web` | Website and storage only, without a rootfs; submissions are judged by remote judge machines |

To validate reference solutions and generate test data with AI, use `all` on the web server: remote judge machines don't replace the local AI execution environment. Architecture diagrams, judge registration and setup steps are in [Distributed judging](wiki/Distributed-Judging.md).

## Documentation

| Documentation | Topics |
| --- | --- |
| [Installation](wiki/Installation.md) · [Docker sources](wiki/Docker-Sources.md) | Installer options, mirrors, service management and retries |
| [Distributed judging](wiki/Distributed-Judging.md) · [Remote judges](wiki/Remote-Judge.md) · [Judge configuration](wiki/Judge-Configuration.md) | Architecture, adding judge machines, the sandbox and capacity |
| [Registration approval](wiki/Registration-Approval.md) · [Two-factor sign-in](wiki/Two-Factor-Sign-In.md) · [Upgrade](wiki/Upgrade.md) | Registration settings, sign-in security, upgrading and rollback |
| [Contest rules](wiki/Contest-Rules.md) · [Hacks](wiki/Hacks.md) · [Self Eval](wiki/Self-Evaluation.md) | Scoring, Hacks and Self Eval |
| [AI features](wiki/AI.md) · [HTTPS](wiki/HTTPS.md) | Model configuration, execution environment and encrypted access |
| [Development](README-DEVELOPMENT.md) · [Source package](deploy/SOURCE-PACKAGE.md) | Building, testing and what the source package contains |

Browse the full [English Wiki](wiki/Home.en.md) / [中文 Wiki](wiki/Home.md).

## License and acknowledgements

LLMOJ is based on LibreOJ. Its own code is under the [MIT](LICENSE) license, and the upstream copyright and license notices are kept. Thanks to LibreOJ and the contributors of its open-source components. Third-party components and the rootfs recipe keep their own licenses; see the [third-party notices](THIRD_PARTY_NOTICES.md).
