# Frontend configuration

[简体中文](Frontend-Configuration.zh-CN.md) | English | [Wiki home](Home.en.md) | [Configuration overview](Configuration.md)

## The frontend built by the installer

The installer builds the frontend with `deploy/build-frontend-offline.mjs` and publishes it to `<installation directory>/public`. "Offline" means the pages load everything from your own server; the build itself may still download missing dependencies and emoji.

The script reads these environment variables:

| Variable | Meaning | Default |
| --- | --- | --- |
| `OJ_SITE_NAME` | Site name shown before the backend's settings load | `LLMOJ` |
| `HYHOJ_PUBLIC_DIR` | Where to publish the pages. Nginx isn't changed to match. | `<installation directory>/public` |
| `HYHOJ_QUOTE_FILE` | Optional JSON file of quotations | none |
| `PNPM_BINARY` | The pnpm program used by `--build` | `pnpm` |

And these options:

- `--build`: build the frontend, then publish it.
- `--assets-only`: only prepare the local assets, then stop (even if `--build` is also given).
- no option: publish an existing build from `dist`.

Pages built this way load their scripts from `/frontend` and call the API on the same site. The libraries they load when needed (the code editor, maths, highlighting and emoji images) are part of the build, under `/frontend/vendor`, so nothing comes from a CDN. These values are fixed in the script.

Publishing rewrites the output files and `index.html`, and adds a `sw.js` that removes the service worker the old CDN bootstrap installed, with its cache. That worker was made for a separate page-only site: on this one it answered API requests with its cached home page and could store an API response, or someone's file, as the home page. Browsers that still have it remove it the next time they open the site. Don't edit the published files by hand; your changes would be lost on the next build.

To rebuild by hand, for example after changing the site name, run this in the installation directory with the installer's Node.js and pnpm. Back up `public` first, and afterwards check the home page, sign-in and uploads in a browser:

```bash
cd /opt/LLMOJ
sudo env PATH=/opt/LLMOJ/runtime/node/bin:/opt/LLMOJ/runtime/tooling/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  OJ_SITE_NAME="AI Practice" /opt/LLMOJ/runtime/node/bin/node deploy/build-frontend-offline.mjs --build
```

## Site name, logo and footer

- **Site name:** set `preference.siteName` in [`backend.yaml`](Backend-Configuration.md), and use the same name as `OJ_SITE_NAME` when you rebuild. The first is shown once the page has loaded; the second while it loads.
- **Logo:** `preference.misc.appLogo` sets the logo shown once the page has loaded. The browser tab icon is part of the frontend build.
- **Footer:** shows "*site name* Powered by LLMOJ", where LLMOJ and the GitHub icon link to [houyhlouis/LLMOJ](https://github.com/houyhlouis/LLMOJ). A custom `preference.copyrightNotice` appears on its own line below; an empty notice, or the old defaults `LLMOJ` and `LibreOJ Open Source Project`, adds nothing.

Your homepage content and the original copyright, license and attribution notices are kept.

**Site management** in the administrator's user menu sets the registration mode; see [Registration approval](Registration-Approval.md).

## Submission and hack preview windows

Clicking an entry in the submission or hack list opens a preview window, 1100 × 720 pixels or the size of the screen if that's smaller. The window shows the usual details page with `embed=1` added to its address, which hides the site's navigation bar. Links inside the window stay in it; lists opened inside it open no further windows. The **#ID** link and ordinary links open the full page. Sign-in, code visibility, contest feedback and every action are checked exactly as on the full page. See [Submissions](Submissions.md) and [Hacks](Hacks.md).

## Generating API types for development

`packages/frontend/scripts/generate-api.js --from-backend-build` regenerates the frontend's API types from the compiled backend (`apps/backend/dist`, after `nest build`), without running it. Without that option, it reads the API description from a backend running at `http://127.0.0.1:2002/docs-json`; to use another backend, pass the full address of its `docs-json` as an argument. A test fails when the types and the backend differ; see [README-DEVELOPMENT](../README-DEVELOPMENT.md).

## The bootstrap CDN build (not used by the installer)

`packages/bootstrap-config/settings.json` belongs to a separate way of publishing the frontend through a CDN, inherited from upstream LibreOJ. The installer doesn't use it, and it hasn't been tested as part of LLMOJ. Its example addresses point to the upstream project's servers: replace all of them before using it, or your site will load from someone else's. Its pages no longer install a service worker: they remove the one earlier versions installed, and its `/sw.js` is the same one the installer publishes.

The file has two sections:

- `env`: named values (not environment variables). A value can refer to an earlier one as `${name}`. The example defines `title`, `cdnRoot`, `apiEndpoint`, `apiEndpointCN`, `bootstrapCdnRoot`, `bootstrapCdnRootStaging`, `assets`, `favicon`, `appLogo`, `gravatar`, `gravatarCN`, `ghAvatar`, `ghAvatarCN`, `cdnjs` and `cdnjsCN`; you can add your own.
- `substitution`: what replaces each placeholder in the pages (`__api_endpoint__`, `__default_title__`, `__public_path__`, `__favicon__`, `__applogo__`, `__gravatar__`, `__ghavatar__`, `__cdnjs__`, `__bootstrap_cdn_root__`, `__bootstrap_cdn_root_staging__`). A value is either one string, or a map from region to string, where `""` is the fallback and `CN` is the China region, for example `{"CN": "${apiEndpointCN}", "": "${apiEndpoint}"}`. The pages no longer contain `__cdnjs__`, since they load their libraries from the build itself, so `cdnjs`, `cdnjsCN` and that substitution have no effect.

After a change, rebuild bootstrap-config and the bootstrap app and deploy the result. The other fields in the generated `config.json` are produced by the build. The build reads Git commit information, so it needs a Git checkout rather than a source archive.

The Cloudflare variant needs `CLOUDFLARE_WORKER_NAME` and `CLOUDFLARE_ACCOUNT_ID`; the Aliyun OSS variant, which publishes the China-region pages, needs `ALIYUN_ACCESS_KEY_ID`, `ALIYUN_ACCESS_KEY_SECRET`, `ALIYUN_OSS_BUCKET` and `ALIYUN_OSS_ENDPOINT`. See [Environment variables](Environment.md). Never put these credentials in `settings.json` or the wiki.

Sources: [build-frontend-offline.mjs](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/build-frontend-offline.mjs), [settings.json](https://github.com/houyhlouis/LLMOJ/blob/main/packages/bootstrap-config/settings.json), [build.ts](https://github.com/houyhlouis/LLMOJ/blob/main/packages/bootstrap-config/src/build.ts), [bootstrap-cloudflare/config.mjs](https://github.com/houyhlouis/LLMOJ/blob/main/apps/bootstrap-cloudflare/config.mjs), [bootstrap-static/deploy-oss.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/bootstrap-static/deploy-oss.ts).
