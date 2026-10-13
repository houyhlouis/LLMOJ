# Prepare a GitHub release

[English publishing guide](../wiki/Publishing.md) | [中文发布教程](../wiki/Publishing.zh-CN.md)

Create a fresh source archive with `python3 deploy/prepare-github.py --archive release/llmoj-source.tar.gz`; the destination must not exist. Extract its LibreOJ/ directory and initialize a clean repository, preserving licenses and notices. Source packages exclude old Git history, actual config, keys, runtime data, rootfs and build output.

Replace repository placeholders in both README languages and Wiki examples before publishing. Public visibility enables anonymous installation. Export both Wiki languages with deploy/export-wiki.py; Home is Chinese, Home.en is English, and Home.zh-CN remains a compatibility page. Commit wiki/*.md in the main repository; updating the GitHub Wiki tab requires a separate commit to the OWNER/REPOSITORY.wiki.git checkout. See the linked publishing guides for the GitHub Desktop workflow. Packing/exporting only writes local files; no repository is created or pushed automatically.
