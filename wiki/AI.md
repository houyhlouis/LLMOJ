# AI services and execution

English | [简体中文](AI.zh-CN.md)

AI configuration belongs to the signed-in user. Features include statement import/translation, source discovery, tag/difficulty assistance, tutorials and sandboxed test-data generation. No model weights, shared API key or paid service are supplied. Service capabilities and fees depend on the user's chosen provider.

## Configure a provider

Use the AI configuration UI to enter your model endpoint, model name and key, configure search/MCP as needed, and test the connection. External providers require HTTPS by default; requests reject redirects, credential-bearing URLs and private destinations. For an intentional trusted local provider, the administrator can set `HYHOJ_AI_PRIVATE_HOSTS` to its exact hostname in the backend service environment and restart the backend.

Provider keys use AES-256-GCM encryption. Reading configuration reveals only whether a key is present. The master key is `data/ai/master.key` inside the installation, with directory mode `0700` and file mode `0600`. Back up an encrypted database together with its matching master key. Neither belongs in a source repository; a different key cannot decrypt the old configuration.

Configure [HTTPS](HTTPS.md) before entering credentials on a public site. The installer supplies no AI key.

## Execution locations

| Action | Location |
| --- | --- |
| Model calls, translation, editing and search | Backend calls configured services |
| Reference-solution execution, generators and validators | Local judge sandbox worker |
| Ordinary submission judging | Local or remote judge |

The AI worker uses a local UNIX socket and private shared directories. Generated programs execute through `simple-sandbox` with filesystem, process, network and resource isolation. `--role all` configures the directories, group permissions and local judge. Review generated content; generated problems are private by default.

`--role web` has no local sandbox and cannot perform these program-execution actions. Adding remote ordinary judges does not provide a remote AI worker protocol. For full AI execution, keep `all` on the web node and add remote judges for ordinary submissions.

For execution failures, check `libreoj-judge.service`, rootfs ID, workspace mounts and the runner socket, then user permissions and provider configuration. Logs/usage records should not contain provider keys, prompt bodies or response bodies.
