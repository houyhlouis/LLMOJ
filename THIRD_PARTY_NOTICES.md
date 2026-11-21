# 第三方组件与发布许可

简体中文 | [English](#third-party-components-and-licenses)

本项目基于 [LibreOJ](https://github.com/LibreOJ/LibreOJ) 二次开发。主体源码采用 MIT 许可，允许使用、修改和公开发布；必须保留 `LICENSE` 中的 `Copyright (c) 2021 Menci`、许可原文和免责声明。各目录原有的 `LICENSE` 继续适用于对应组件。主体 MIT 不覆盖第三方软件、字体、题目、测试数据或其他内容的独立权利。

## 主要软件组件

实际版本以 `pnpm-lock.yaml` 和构建时取得的组件为准；以下说明不能替代各组件完整许可证。

| 组件 | 许可 | 来源与说明 |
| --- | --- | --- |
| LibreOJ frontend / backend / judge | MIT | [LibreOJ 上游](https://github.com/LibreOJ/LibreOJ)；保留项目各目录 `LICENSE`。 |
| simple-sandbox | MIT | `packages/simple-sandbox/LICENSE`，版权归 Tian Yunhao；保留原声明。 |
| sandbox-rootfs 构建配方 | Unlicense | `infra/sandbox-rootfs/LICENSE`；[上游配方](https://github.com/LibreOJ/sandbox-rootfs)。此许可只覆盖配方，不覆盖镜像内全部系统组件。 |
| testlib | MIT | [testlib LICENSE](https://github.com/MikeMirzayanov/testlib/blob/master/LICENSE)；保留 `apps/judge/vendor/testlib/LICENSE` 和 Mike Mirzayanov 版权声明。 |
| React / React DOM、Monaco Editor、MobX、Axios、Noty、Fomantic UI、Semantic UI React | MIT | 各上游：[React](https://github.com/facebook/react)、[Monaco](https://github.com/microsoft/monaco-editor)、[MobX](https://github.com/mobxjs/mobx)、[Axios](https://github.com/axios/axios)、[Noty](https://github.com/needim/noty)、[Fomantic UI](https://github.com/fomantic/Fomantic-UI)、[Semantic UI React](https://github.com/Semantic-Org/Semantic-UI-React)。 |
| MathJax 3 | Apache-2.0 | [MathJax 源码与许可](https://github.com/mathjax/MathJax)。 |
| Prism | MIT | [Prism 源码与许可](https://github.com/PrismJS/prism)。 |
| Twemoji 15 代码 / 图形（`@twemoji/api`、`@twemoji/svg`） | MIT / CC-BY-4.0 | [Twemoji](https://github.com/jdecked/twemoji)；图形许可证见 `@twemoji/api` 包内的 `LICENSE-GRAPHICS`，前端发布时随附于 `licenses/@twemoji/api/`。图形须注明 Twitter / Twemoji 来源、许可链接及适用的修改说明。 |
| MinIO JavaScript SDK 8 | Apache-2.0 | [MinIO JS SDK](https://github.com/minio/minio-js)；它与 MinIO Server 的许可不同。 |
| MinIO Server（独立外部服务） | AGPL-3.0 | [服务器 LICENSE](https://github.com/minio/minio/blob/master/LICENSE)、[合规说明](https://github.com/minio/minio/blob/master/COMPLIANCE.md)。本仓库不附带服务器二进制。分发时须保留许可并提供对应源码；修改服务器并供网络用户使用时须履行 AGPL 第 13 条。 |
| MariaDB Connector/Node.js 3.5 | LGPL-2.1-or-later | [MariaDB Connector LICENSE](https://github.com/mariadb-corporation/mariadb-connector-nodejs/blob/main/LICENSE)。分发时保留许可与适用源码，保障使用者替换或修改该独立依赖的权利。 |
| sharp / libvips | Apache-2.0 / LGPL-3.0-or-later | [sharp](https://github.com/lovell/sharp)、[libvips 预编译包许可](https://github.com/lovell/sharp-libvips/blob/main/LICENSE)。打包原生库时须保留各自许可并满足对应源码及适用的替换或重链接义务。 |
| geoip-country 5 库 / GeoLite 数据 | Apache-2.0 / MaxMind EULA | [MaxMind GeoLite EULA](https://www.maxmind.com/en/geolite/eula)。数据库应由部署者按条款取得、署名和更新；不将其当作普通 Apache 代码随源码包分发。 |

通过标准接口使用独立服务器、操作系统或编译器，不会仅因这些组件采用 GPL / AGPL 就自动改变主体源码的许可。涉及合并、修改或再分发时，应按实际组件和连接方式核对义务。

## 字体

CSS / npm 包的 MIT 元数据不替代字体文件本身的许可。下表按当前依赖所含字体文件的版权与许可元数据区分；升级字体后须重新核对。

| 字体 | 字体许可 | 来源 |
| --- | --- | --- |
| Fira Code、JetBrains Mono、DM Mono、Inconsolata、Noto Sans、Noto Serif、Nunito Sans、Open Sans、PT Mono、PT Sans、Roboto、Roboto Mono、Source Code Pro、Source Serif Pro、Zilla Slab、Lato、Saira | SIL OFL-1.1 | [Google Fonts 官方字体与逐字体许可](https://github.com/google/fonts)、[Fira Code](https://github.com/tonsky/FiraCode)、[JetBrains Mono](https://github.com/JetBrains/JetBrainsMono)。 |
| 当前依赖中的 Roboto Slab | Apache-2.0 | 当前 Fontsource 5.x 字体文件的许可元数据；[Google Fonts](https://github.com/google/fonts)。同名字体的不同版本可能采用不同许可：Fontsource 4.5.x 中的 Roboto、Roboto Mono 和 Noto Serif 为 Apache-2.0，5.x 中为 OFL-1.1。 |
| Ubuntu Mono | Ubuntu Font Licence 1.0 | [Ubuntu 字体官方说明](https://design.ubuntu.com/font)、[Ubuntu Mono UFL 原文](https://github.com/google/fonts/blob/main/ufl/ubuntumono/UFL.txt)。 |
| Hack 3.3.0 | MIT + Bitstream Vera License；DejaVu 部分为公有领域 | [Hack LICENSE](https://github.com/source-foundry/Hack/blob/master/LICENSE.md)。保留全部声明，并遵守保留字体名称和修改版改名条件。 |

分发 OFL 字体须保留字体版权与 OFL 原文；修改版须遵守保留字体名条件，字体本身不能改用主体 MIT 许可。UFL 与 Bitstream Vera 也有名称及分发条件。

Apple SF Mono 不作为本项目的网页字体或发布资源。Apple 官方明确要求[不要随应用打包 SF Mono 等字体](https://developer.apple.com/documentation/technologyoverviews/fonts)，并在[字体许可](https://developer.apple.com/fonts/index.html)中限制嵌入、网站使用、网络提供及再分发；第三方 npm 包标注 MIT 不授予 Apple 原字体的权利。

## 沙盒与系统镜像

默认评测环境使用 LibreOJ 上游 `infra/sandbox-rootfs` 构建配方。构建所得 Ubuntu、GNU 工具链及各语言运行时分别采用自己的许可证。发布配方与发布整个 rootfs 二进制镜像是两种分发行为；若发布镜像，须清点其中的软件，附上对应版权、许可和通知，并为 GPL / LGPL 等组件提供适用的对应源码。另应遵守 [Canonical 商标与知识产权政策](https://canonical.com/legal/intellectual-property-policy)。

本项目不内置、不使用、不分发 NOI Linux 2.0 ISO、rootfs 或 Arbiter-local。NOI [官方发布页](https://www.noi.cn/gynoi/jsgz/2021-07-16/732450.shtml)提供下载与试用说明，没有为整个 ISO 赋予统一开源许可；清单含专有软件。[Sublime Text EULA](https://www.sublimetext.com/eula)与[微软发行版 VS Code 许可](https://code.visualstudio.com/license?lang=en)限制再分发。未取得 Arbiter-local 明确许可时，不得主张其开源或取得再分发授权。以后若另行使用 NOI 环境，应由使用者从官方取得并自行核对相应许可，不将其加入本仓库发布包。

## 源码、离线资源与二进制发布

源码发布应保留原许可证、子模块信息与依赖锁文件。运行数据、安装后的 `node_modules`、数据库、缓存、系统镜像和本机构建产物不属于源码发布内容。

如另行发布前端编译结果、离线 CDN 资源或二进制安装包，应按实际打入的全部依赖生成随包的第三方许可文件，保留版权、许可原文及适用的 `NOTICE`，包括字体和 Twemoji 图形；Apache、CC、GPL / LGPL / AGPL 等组件还须履行相应通知、署名及源码义务。本文件只是主要组件索引，不能替代完整许可原文或该构建的依赖清单。题面、数据、歌词、图片等内容须另行取得许可。

---

<a id="third-party-components-and-licenses"></a>

# Third-party components and licenses

[简体中文](#第三方组件与发布许可) | English. This is a translation of the Chinese text above; where the two differ, the license texts themselves decide.

This project is developed from [LibreOJ](https://github.com/LibreOJ/LibreOJ). Its own source code is under the MIT license, which allows using, changing and publishing it, as long as `Copyright (c) 2021 Menci`, the license text and its disclaimer in `LICENSE` are kept. The `LICENSE` files in individual directories still apply to their components. The project's MIT license doesn't cover the separate rights in third-party software, fonts, problems, test data or other content.

## Main software components

The actual versions are those in `pnpm-lock.yaml` and the components fetched while building; this summary doesn't replace each component's full license.

| Component | License | Source and notes |
| --- | --- | --- |
| LibreOJ frontend / backend / judge | MIT | [LibreOJ upstream](https://github.com/LibreOJ/LibreOJ); the `LICENSE` files of the project's directories are kept. |
| simple-sandbox | MIT | `packages/simple-sandbox/LICENSE`, copyright Tian Yunhao; the original notice is kept. |
| sandbox-rootfs build recipe | Unlicense | `infra/sandbox-rootfs/LICENSE`; [upstream recipe](https://github.com/LibreOJ/sandbox-rootfs). This license covers the recipe only, not every system component in the image. |
| testlib | MIT | [testlib LICENSE](https://github.com/MikeMirzayanov/testlib/blob/master/LICENSE); `apps/judge/vendor/testlib/LICENSE` and Mike Mirzayanov's copyright notice are kept. |
| React / React DOM, Monaco Editor, MobX, Axios, Noty, Fomantic UI, Semantic UI React | MIT | Upstream: [React](https://github.com/facebook/react), [Monaco](https://github.com/microsoft/monaco-editor), [MobX](https://github.com/mobxjs/mobx), [Axios](https://github.com/axios/axios), [Noty](https://github.com/needim/noty), [Fomantic UI](https://github.com/fomantic/Fomantic-UI), [Semantic UI React](https://github.com/Semantic-Org/Semantic-UI-React). |
| MathJax 3 | Apache-2.0 | [MathJax source and license](https://github.com/mathjax/MathJax). |
| Prism | MIT | [Prism source and license](https://github.com/PrismJS/prism). |
| Twemoji 15 code / graphics (`@twemoji/api`, `@twemoji/svg`) | MIT / CC-BY-4.0 | [Twemoji](https://github.com/jdecked/twemoji). The graphics license is `LICENSE-GRAPHICS` in the `@twemoji/api` package, shipped with the frontend in `licenses/@twemoji/api/`. The graphics must credit Twitter / Twemoji, link the license and say what was changed, where anything was. |
| MinIO JavaScript SDK 8 | Apache-2.0 | [MinIO JS SDK](https://github.com/minio/minio-js); its license differs from MinIO Server's. |
| MinIO Server (a separate, external service) | AGPL-3.0 | [Server LICENSE](https://github.com/minio/minio/blob/master/LICENSE), [compliance notes](https://github.com/minio/minio/blob/master/COMPLIANCE.md). This repository ships no server binary. Distributing one requires keeping its license and providing the corresponding source; offering a modified server to users over a network brings the obligations of AGPL section 13. |
| MariaDB Connector/Node.js 3.5 | LGPL-2.1-or-later | [MariaDB Connector LICENSE](https://github.com/mariadb-corporation/mariadb-connector-nodejs/blob/main/LICENSE). Distributing it means keeping the license and the applicable source, and preserving users' right to replace or change this separate dependency. |
| sharp / libvips | Apache-2.0 / LGPL-3.0-or-later | [sharp](https://github.com/lovell/sharp), [license of the prebuilt libvips packages](https://github.com/lovell/sharp-libvips/blob/main/LICENSE). Packaging the native libraries means keeping each license and meeting the corresponding source and any replace-or-relink obligations. |
| geoip-country 5 library / GeoLite data | Apache-2.0 / MaxMind EULA | [MaxMind GeoLite EULA](https://www.maxmind.com/en/geolite/eula). Whoever deploys the site should obtain, credit and update the database under its terms; it isn't distributed with the source as ordinary Apache-licensed code. |

Using a separate server, operating system or compiler through its standard interfaces doesn't by itself change the license of the project's code because those components are under the GPL or AGPL. When combining, changing or redistributing them, check the obligations for the actual components and how they are linked.

## Fonts

The MIT metadata of CSS or npm packages doesn't replace the license of the font files themselves. The table below follows the copyright and license metadata of the font files in the current dependencies; check again after upgrading fonts.

| Font | Font license | Source |
| --- | --- | --- |
| Fira Code, JetBrains Mono, DM Mono, Inconsolata, Noto Sans, Noto Serif, Nunito Sans, Open Sans, PT Mono, PT Sans, Roboto, Roboto Mono, Source Code Pro, Source Serif Pro, Zilla Slab, Lato, Saira | SIL OFL-1.1 | [Google Fonts' fonts and per-font licenses](https://github.com/google/fonts), [Fira Code](https://github.com/tonsky/FiraCode), [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono). |
| Roboto Slab in the current dependencies | Apache-2.0 | The license metadata of the current Fontsource 5.x font files; [Google Fonts](https://github.com/google/fonts). Different versions of a font of the same name can have different licenses: in Fontsource 4.5.x, Roboto, Roboto Mono and Noto Serif are Apache-2.0, and in 5.x OFL-1.1. |
| Ubuntu Mono | Ubuntu Font Licence 1.0 | [Ubuntu font page](https://design.ubuntu.com/font), [Ubuntu Mono UFL text](https://github.com/google/fonts/blob/main/ufl/ubuntumono/UFL.txt). |
| Hack 3.3.0 | MIT + Bitstream Vera License; the DejaVu parts are in the public domain | [Hack LICENSE](https://github.com/source-foundry/Hack/blob/master/LICENSE.md). Keep every notice, and follow the conditions on keeping the font names and renaming changed versions. |

Distributing OFL fonts requires keeping the font copyright and the OFL text; changed versions must follow its reserved-font-name condition, and the fonts can't be relicensed under the project's MIT license. The UFL and the Bitstream Vera License also have naming and distribution conditions.

Apple SF Mono isn't a web font or release asset of this project. Apple explicitly says [not to bundle SF Mono and other fonts with apps](https://developer.apple.com/documentation/technologyoverviews/fonts), and its [font license](https://developer.apple.com/fonts/index.html) restricts embedding, website use, network provision and redistribution; an MIT label on a third-party npm package grants no rights to Apple's original fonts.

## The sandbox and system images

The default judging environment uses LibreOJ's upstream `infra/sandbox-rootfs` build recipe. The Ubuntu system, GNU toolchain and language runtimes it builds keep their own licenses. Publishing the recipe and publishing a whole rootfs binary image are two different kinds of distribution: to publish an image, take an inventory of the software in it, include the matching copyrights, licenses and notices, and provide the applicable corresponding source for GPL / LGPL and similar components. Follow [Canonical's trademark and intellectual property policy](https://canonical.com/legal/intellectual-property-policy) too.

This project doesn't include, use or distribute the NOI Linux 2.0 ISO, its rootfs or Arbiter-local. The NOI [official release page](https://www.noi.cn/gynoi/jsgz/2021-07-16/732450.shtml) gives download and trial instructions but no single open-source license for the whole ISO, whose contents include proprietary software. The [Sublime Text EULA](https://www.sublimetext.com/eula) and the [license of Microsoft's VS Code distribution](https://code.visualstudio.com/license?lang=en) restrict redistribution. Without an explicit license for Arbiter-local, don't claim it is open source or that it may be redistributed. If an NOI environment is used separately in the future, whoever uses it should obtain it from the official source and check its licenses themselves; it isn't added to this repository's releases.

## Source, offline assets and binary releases

A source release keeps the original licenses, the submodule information and the dependency lockfile. Runtime data, an installed `node_modules`, databases, caches, system images and local build output aren't part of a source release.

Publishing a compiled frontend, offline CDN assets or a binary installation package separately requires a third-party license file generated from every dependency actually included, keeping copyrights, license texts and any applicable `NOTICE` files, fonts and Twemoji graphics included; Apache, CC, GPL / LGPL / AGPL and similar components also bring their notice, attribution and source obligations. This file is only an index of the main components and replaces neither the full license texts nor a build's dependency inventory. Problem statements, test data, lyrics, images and other content need their own permission.
