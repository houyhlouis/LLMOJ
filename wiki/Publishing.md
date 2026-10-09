# Source, release and GitHub Wiki publishing

English | [简体中文](Publishing.zh-CN.md)

These steps are for the repository owner. Local packaging does not create repositories, push Git or publish releases. The project name is LLMOJ; the default README is Chinese, with English in `README.en.md`. The Wiki provides both languages.

## 1. Make a clean source directory

Generate a source archive. Use a new filename if it exists; the tool refuses overwrites.

```bash
cd /opt/LibreOJ
python3 deploy/prepare-github.py --archive release/llmoj-source.tar.gz
sha256sum release/llmoj-source.tar.gz
mkdir -p ~/llmoj-publish
tar -xzf release/llmoj-source.tar.gz -C ~/llmoj-publish
cd ~/llmoj-publish/LibreOJ
```

The archive contains a `LibreOJ/` source directory. Do not copy the deployment's old `.git`, runtime, data, logs, real configuration or API keys.

testlib source and LICENSE are included as ordinary files. Keep them in the new repository so GitHub snapshots install directly; do not replace the directory with a gitlink alone. `.gitmodules` retains upstream provenance while the actual files are committed.

## 2. Create and push a public repository

Create an empty Public repository on GitHub, without auto-generated README/LICENSE. Keep the supplied MIT license, upstream copyright and third-party notices. Replace every `houyhlouis/LLMOJ` in both README languages and the Wiki installation commands with the real path.

```bash
git init -b main
git add .
git diff --cached --stat
git commit -m "Initial LLMOJ source release"
git remote add origin https://github.com/houyhlouis/LLMOJ.git
git push -u origin main
```

Use your configured GitHub CLI, credential manager or personal token for HTTPS authentication. Do not embed tokens in remotes, scripts or docs. You can review privately first, but anonymous one-command installation requires a public repository.

Before tagging, test both language entry points on fresh Ubuntu servers: full/web roles, custom ports, official/custom Docker sources, admin initialization and independent judges.

```bash
git tag v0.1.0
git push origin v0.1.0
```

The version is an example. Pin both the downloaded script URL and `--ref` to the same release tag. Deployment and core functionality have been verified on Ubuntu 24.04 amd64. Validate your release and deployment layout before publishing; real multi-machine acceptance testing remains separate.

## 3. Publish both Wiki languages

Repository Markdown is readable as ordinary documentation; GitHub Wiki has its own repository. Enable Wiki in Settings and create its first Home page in the browser before cloning. See [GitHub's Wiki guide](https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages).

```bash
cd ~/llmoj-publish/LibreOJ
git clone https://github.com/houyhlouis/LLMOJ.wiki.git ~/llmoj-wiki
python3 deploy/export-wiki.py --repository houyhlouis/LLMOJ --output ~/llmoj-wiki
cd ~/llmoj-wiki
git diff
git add -- '*.md'
git commit -m "Add bilingual deployment documentation"
git push
```

The exporter only writes local Markdown; it does not run Git or access the network. It converts page links and generates a bilingual sidebar. `Home` is Chinese and `Home.en` is English. `Home.zh-CN` remains a compatibility entry. The Chinese sidebar section comes first. Existing matching pages are replaced, so inspect the diff before pushing. Use the same process for updates.

## Updating existing documentation with GitHub Desktop

A documentation-only update package does not require republishing the source release:

1. Open the local `houyhlouis/LLMOJ` repository in GitHub Desktop and synchronize remote changes.
2. Merge the package's `wiki/` contents into the same directory, retaining original pages absent from the package. Review Changes for the expected Markdown files, enter a summary, commit, and Push origin. Do not commit the ZIP, audit records, or private server configuration.
3. This updates documentation under Code. The GitHub **Wiki tab** uses the separate `https://github.com/houyhlouis/LLMOJ.wiki.git` repository. Create its first page on GitHub, then use Desktop's File → Clone Repository → URL. If the special Wiki URL is rejected, clone using the command above and use File → Add Local Repository in Desktop.
4. Run `export-wiki.py` from the source repository with `--output` pointing to the Wiki repository. Review, commit, and push that repository separately. If the update package includes exported pages, copy the `.md` files **inside** that export directory into the Wiki repository root, without an extra `wiki/` directory.

The repositories have independent commits. Source pages retain relative `.md` links; exported Wiki pages use page URLs and include `_Sidebar.md`. Keep these sets separate. Export updates same-name pages within its scope; retain any additional manually maintained pages.

References: [local Wiki editing](https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages), [cloning with GitHub Desktop](https://docs.github.com/en/desktop/adding-and-cloning-repositories/cloning-and-forking-repositories-from-github-desktop).

## 4. Distribution and licenses

Main source is MIT; the original rootfs recipe is Unlicense. MinIO, databases, compilers, fonts and other components retain their own licenses. A source release does not relicense them; preserve licenses/notices.

Rootfs is built on the installation server. Source archives exclude complete rootfs, NOI Linux images and runtime data. Distributing compiled binaries or rootfs as Release assets requires separate review of notices, applicable source obligations and redistribution terms.
