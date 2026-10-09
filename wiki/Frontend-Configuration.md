# Frontend and bootstrap configuration

English | [简体中文](Frontend-Configuration.zh-CN.md) | [Configuration overview](Configuration.md)

## Local frontend used by one-click installation

One-click installation uses `deploy/build-frontend-offline.mjs` to stage dependencies, build, and publish to `<root>/public`. “Offline” means locally served runtime assets; initial preparation of missing dependencies/emoji may still require network access.

Inputs are `OJ_SITE_NAME` (LLMOJ), `HYHOJ_PUBLIC_DIR` (`<root>/public`), optional `HYHOJ_QUOTE_FILE` (quotation JSON), and `PNPM_BINARY` (pnpm, used with `--build`). `--assets-only` stages assets and exits; `--build` builds and publishes; no flag publishes an existing `dist`. Passing both flags does not perform a full build because assets-only exits early. The build sets `NODE_OPTIONS=--max-old-space-size=2300`.

The following substitutions are currently fixed in the script, not additional environment variables:

| Placeholder | Local value |
| --- | --- |
| `__public_path__` | `/frontend` |
| `__default_title__` | `OJ_SITE_NAME / LLMOJ` |
| `__api_endpoint__` | `"" → /` |
| `__favicon__` | `""` |
| `__applogo__` | `null` |
| `__gravatar__` | `https://gravatar.com` |
| `__ghavatar__` | `https://github.com` |
| `__cdnjs__` | `/cdnjs` |

Changing the name usually requires both backend `preference.siteName` and `OJ_SITE_NAME` during rebuilding. `preference.misc.appLogo` affects the logo after public configuration loads; the favicon and initial bootstrap assets belong to frontend publication. `HYHOJ_PUBLIC_DIR` does not update Nginx `root`. Publication rewrites output assets and `index.html`, and generates `sw.js` to unregister the old service worker and clear caches; generated output is not a permanent source-edit location.

With complete source and dependencies, the following example can run in a maintenance/build tree. It writes static files: back up the output first and substitute actual paths/name. Use the installer-compatible Node/pnpm and ownership, then verify the home page, asset loading, login, uploads, and browser caches.

```bash
cd /opt/LibreOJ
sudo env PATH=/opt/LibreOJ/runtime/node/bin:/opt/LibreOJ/runtime/tooling/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin   OJ_SITE_NAME="AI Practice"   /opt/LibreOJ/runtime/node/bin/node deploy/build-frontend-offline.mjs --build
```

## Optional upstream CDN/bootstrap path

`packages/bootstrap-config/settings.json` belongs to a separate bootstrap deployment system and is not read by local one-click installation. Its example values reference upstream services: replace them before independent deployment or requests/assets will point to someone else's site. This legacy path received a structural documentation review, not a deployment acceptance test.

`env` is a JSON dictionary, **not process environment**. The builder expands `${name}` references in order, allowing later values to refer to earlier keys. All 15 current example keys are listed below; custom string keys can be added for substitutions.

| Key | Example (not local default) | Purpose |
| --- | --- | --- |
| `env.title` | `LibreOJ` | Initial page title |
| `env.cdnRoot` | `https://static.cdn.menci.xyz/libreoj-frontend` | Frontend asset base |
| `env.apiEndpoint` | `https://api.loj.ac` | Default-region backend address |
| `env.apiEndpointCN` | `https://api.loj.ac` | CN-region backend address |
| `env.bootstrapCdnRoot` | `bootstrap.loj.ac.cn` | Production bootstrap domain |
| `env.bootstrapCdnRootStaging` | `bootstrap-staging.loj.ac.cn` | Staging bootstrap domain |
| `env.assets` | `https://static.cdn.menci.xyz/libreoj-assets` | Common favicon/logo asset prefix |
| `env.favicon` | `${assets}/favicon.ico` | Favicon URL |
| `env.appLogo` | `${assets}/logo-website.min.svg` | Site logo URL |
| `env.gravatar` | `https://gravatar.com` | Default Gravatar service |
| `env.gravatarCN` | `https://cravatar.cn` | CN Gravatar service |
| `env.ghAvatar` | `https://github.com` | Default GitHub avatar service |
| `env.ghAvatarCN` | `https://cdn.menci.xyz/gh-avatar` | CN GitHub avatar service |
| `env.cdnjs` | `https://cdnjs.cloudflare.com/ajax/libs` | Default dependency CDN |
| `env.cdnjsCN` | `https://cdnjs.baoshuo.ren/ajax/libs` | CN dependency CDN |

A `substitution` value can be a string shared by all regions or a region-to-string mapping. Empty key `""` is the fallback; `CN` is the current China-region example, with other codes extensible. Every current placeholder and mapping follows:

| Key | Value |
| --- | --- |
| `substitution.__api_endpoint__` | `{"CN": "${apiEndpointCN}", "": "${apiEndpoint}"}` |
| `substitution.__default_title__` | `"${title}"` |
| `substitution.__public_path__` | `{"": "${cdnRoot}"}` |
| `substitution.__favicon__` | `{"": "${favicon}"}` |
| `substitution.__applogo__` | `{"": "${appLogo}"}` |
| `substitution.__gravatar__` | `{"CN": "${gravatarCN}", "": "${gravatar}"}` |
| `substitution.__ghavatar__` | `{"CN": "${ghAvatarCN}", "": "${ghAvatar}"}` |
| `substitution.__cdnjs__` | `{"CN": "${cdnjsCN}", "": "${cdnjs}"}` |
| `substitution.__bootstrap_cdn_root__` | `{"": "${bootstrapCdnRoot}"}` |
| `substitution.__bootstrap_cdn_root_staging__` | `{"": "${bootstrapCdnRootStaging}"}` |

Rebuild bootstrap-config and the relevant bootstrap application, then deploy HTML/service-worker/static assets. Generated `config.json` fields `responseDataForRegion`, `body`, `contentType`, `cacheControl`, `serviceWorker`, and `buildInfo` are build outputs, not additional manual settings. This build path reads Git commit metadata; a source archive is not equivalent to a full Git worktree.

The Cloudflare variant requires `CLOUDFLARE_WORKER_NAME` and `CLOUDFLARE_ACCOUNT_ID` to generate `wrangler.toml`. The OSS variant requires `ALIYUN_ACCESS_KEY_ID`, `ALIYUN_ACCESS_KEY_SECRET`, `ALIYUN_OSS_BUCKET`, and `ALIYUN_OSS_ENDPOINT` and publishes CN-region pages. Neither is part of one-click deployment. Keep credentials out of settings.json and the Wiki; see [Environment](Environment.md).

Sources: [deploy/build-frontend-offline.mjs](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/build-frontend-offline.mjs), [packages/bootstrap-config/settings.json](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/packages/bootstrap-config/settings.json), [packages/bootstrap-config/src/build.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/packages/bootstrap-config/src/build.ts), [apps/bootstrap-cloudflare/config.mjs](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/bootstrap-cloudflare/config.mjs), [apps/bootstrap-static/deploy-oss.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/bootstrap-static/deploy-oss.ts).
