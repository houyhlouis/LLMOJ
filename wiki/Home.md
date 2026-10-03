# LLMOJ Wiki

English | [简体中文](Home.zh-CN.md)

LLMOJ is a LibreOJ-based online judge with LLM-assisted problem authoring and learning.

| Task | Guide |
| --- | --- |
| First installation, ports and site name | [Installation](Installation.md) |
| Custom Docker package and image sources | [Docker-Sources](Docker-Sources.md) |
| Web/judge separation and multiple judges | [Distributed-Judging](Distributed-Judging.md) |
| Independent judge installation | [Remote-Judge](Remote-Judge.md) |
| Models and the local AI sandbox worker | [AI](AI.md) |
| Domains, HTTPS and reverse proxies | [HTTPS](HTTPS.md) |
| Source releases and GitHub Wiki | [Publishing](Publishing.md) |

Complete installation keeps a local judge and AI execution worker; add remote judges to distribute ordinary submissions. Web-only installation (`--role web`) does not build rootfs and cannot run the local AI reference-solution/test-data workflows.

The main source is MIT; upstream and third-party components retain their own licenses. Source releases exclude credentials, databases and complete rootfs.
