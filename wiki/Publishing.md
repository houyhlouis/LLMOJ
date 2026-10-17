# Publishing source and the wiki

[简体中文](Publishing.zh-CN.md) | English | [Wiki home](Home.en.md)

These steps are for the repository's maintainers. None of LLMOJ's packaging tools create repositories, push to Git or publish releases: you do that yourself.

Commits to the repository don't change a running site. To install a new version on a server, use the [upgrader](Upgrade.md) after the change is on GitHub.

## Applying an update with GitHub Desktop

An update package of changed files is applied on top of a complete copy of the repository:

1. Open your local copy of `houyhlouis/LLMOJ` in GitHub Desktop and fetch the latest changes first.
2. Extract the package into the repository's root directory, keeping its paths (`apps`, `packages`, `deploy`, `wiki`, `.github` and so on). Files the package doesn't contain stay as they are.
3. In **Changes**, check that only the expected files changed. Enter the summary, commit, and **Push origin**. Don't commit the ZIP itself, or any server configuration.
4. Wait for the GitHub Actions checks to pass before upgrading a server.

A package isn't a complete source tree and can't be installed on its own.

## Publishing the GitHub wiki

The `wiki/` directory in the repository can be read on GitHub as ordinary documentation. The **Wiki** tab is a separate repository, `https://github.com/houyhlouis/LLMOJ.wiki.git`, and committing to the main repository doesn't update it.

The first time, enable the wiki in the repository's **Settings** and create a first page on GitHub; then clone it:

```bash
git clone https://github.com/houyhlouis/LLMOJ.wiki.git ~/llmoj-wiki
```

(In GitHub Desktop, use **File → Clone Repository → URL**. If Desktop refuses the wiki address, clone it with the command above and add it with **File → Add Local Repository**.)

To publish, export the pages from the main repository into the wiki repository, check the changes and push:

```bash
cd /path/to/LLMOJ
python3 deploy/export-wiki.py --repository houyhlouis/LLMOJ --output ~/llmoj-wiki
cd ~/llmoj-wiki
git diff
git add -- '*.md'
git commit -m "Update documentation"
git push
```

The exporter only writes Markdown files: it doesn't run Git or use the network. It turns links between pages into wiki links and writes a bilingual sidebar, `_Sidebar.md`, with Chinese first. `Home` is the Chinese home page and `Home.en` the English one; `Home.zh-CN` is kept so that old links still work. Pages with the same names are replaced, so check `git diff` before pushing; pages that exist only in the wiki are kept.

If an update package already contains exported wiki pages, copy the `.md` files from inside its export directory into the wiki repository's root, not into a `wiki/` subdirectory, and never over its `.git`.

See GitHub's guides to [editing wikis locally](https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages) and [cloning with GitHub Desktop](https://docs.github.com/en/desktop/adding-and-cloning-repositories/cloning-and-forking-repositories-from-github-desktop).

## Tagging a release

Before tagging, test both installers (`install.sh` and `install.zh-CN.sh`) on fresh Ubuntu servers: the `all` and `web` roles, a custom port, the default and custom Docker sources, the first administrator, and a remote judge. Then:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The version is an example. People installing a release should use the tag both in the download URL and in `--ref`.

## Starting a new repository from a source archive

To publish LLMOJ in a new repository from an installed copy, create a clean source archive first. It contains only the files Git tracks, without the old `.git`, `runtime`, `data`, logs, real configuration or keys. The tool refuses to overwrite an existing archive, so choose a new name if needed.

```bash
cd /opt/LLMOJ
python3 deploy/prepare-github.py --archive release/llmoj-source.tar.gz
sha256sum release/llmoj-source.tar.gz
mkdir -p ~/llmoj-publish
tar -xzf release/llmoj-source.tar.gz -C ~/llmoj-publish
cd ~/llmoj-publish/LibreOJ
```

The archive contains a `LibreOJ/` directory. testlib and its license are included as ordinary files: commit them as they are, so that GitHub's download snapshots can be installed directly, rather than turning the directory back into a submodule link. `.gitmodules` still records where testlib comes from.

Create an empty **public** repository on GitHub, without a generated README or license (anonymous one-command installation needs a public repository). Replace `houyhlouis/LLMOJ` with your repository's path in both READMEs and in the wiki's commands, then push:

```bash
git init -b main
git add .
git diff --cached --stat
git commit -m "Initial LLMOJ source release"
git remote add origin https://github.com/houyhlouis/LLMOJ.git
git push -u origin main
```

Sign in with the GitHub CLI, a credential manager or a personal access token; never put a token in a remote URL, script or document.

## Licenses

LLMOJ's own source is MIT-licensed, and the original sandbox image recipe is released under the Unlicense. MinIO, the databases, compilers, fonts and other components keep their own licenses: publishing this repository doesn't relicense them, so keep every license and copyright notice.

The sandbox image is built on each server during installation; the source contains no built image, NOI Linux image or site data. Before attaching built programs or a sandbox image to a release, check each component's notices, source-code obligations and redistribution terms.
