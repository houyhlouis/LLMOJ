#!/usr/bin/env python3
"""Export local Wiki pages; no network or Git operations."""
# SPDX-License-Identifier: MIT
import argparse
from pathlib import Path
import re


LOCAL_MARKDOWN_LINK = re.compile(
    r"\]\((?P<path>(?:(?:\./)?wiki/|\./|\.\./)?[A-Za-z0-9_.-]+\.md)(?P<anchor>#[^)]*)?\)"
)


def rewrite_links(content, names, repository):
    """Accept both Wiki-relative and README-style wiki/Page.md links."""
    base = f"https://github.com/{repository}"

    def link(match):
        relative = match["path"].removeprefix("./")
        anchor = match["anchor"] or ""
        if relative.startswith("../"):
            filename = relative.removeprefix("../")
            if filename.startswith("README"):
                return f"]({base}/blob/main/{filename}{anchor})"
            # Other repository source links should use an explicit revision URL.
            return match[0]
        stem = relative.removeprefix("wiki/").removesuffix(".md")
        if stem not in names:
            raise ValueError(f"Unknown Wiki page: {stem}")
        return f"]({base}/wiki/{stem}{anchor})"

    return LOCAL_MARKDOWN_LINK.sub(link, content)


def page_language(page):
    if page.stem == "Home" or page.stem.endswith(".zh-CN"):
        return "zh-CN"
    return "en"


def sidebar(pages, repository):
    # Home.zh-CN remains exported for old links but should not duplicate Home.
    pages = [page for page in pages if not page.stem.startswith("_") and page.stem != "Home.zh-CN"]
    base = f"https://github.com/{repository}/wiki/"
    sections = []
    for language, title in [("zh-CN", "简体中文"), ("en", "English")]:
        selected = sorted(
            (page for page in pages if page_language(page) == language),
            key=lambda page: (page.stem not in {"Home", "Home.en"}, page.stem),
        )
        lines = []
        for page in selected:
            heading = next((line[2:].strip() for line in page.read_text().splitlines() if line.startswith("# ")), page.stem)
            label = heading.replace("[", r"\[").replace("]", r"\]")
            lines.append(f"- [{label}]({base}{page.stem})")
        sections.append(title + "\n\n" + "\n".join(lines))
    return "\n\n".join(sections) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True, help="OWNER/REPOSITORY")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository):
        parser.error("Use OWNER/REPOSITORY")
    source = Path(__file__).resolve().parents[1] / "wiki"
    output = args.output.expanduser().resolve()
    if output == source or source in output.parents:
        parser.error("Choose an output outside the source Wiki directory")
    pages = sorted(source.glob("*.md"))
    names = {page.stem for page in pages}
    rendered = {page.name: rewrite_links(page.read_text(), names, args.repository) for page in pages}
    rendered["_Sidebar.md"] = sidebar(pages, args.repository)
    output.mkdir(parents=True, exist_ok=True)
    for name in rendered:
        if (output / name).is_symlink():
            raise ValueError(f"Refusing symlink output: {name}")
    for name, content in rendered.items():
        (output / name).write_text(content)
    print(f"Exported {len(rendered)} local pages; inspect the diff before pushing.")


if __name__ == "__main__":
    main()
