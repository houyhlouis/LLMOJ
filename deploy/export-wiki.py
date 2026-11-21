#!/usr/bin/env python3
"""Export local Wiki pages or compare them with an existing Wiki checkout."""
# SPDX-License-Identifier: MIT
import argparse
from pathlib import Path
import re
import tempfile


DEFAULT_REPOSITORY = "houyhlouis/LLMOJ"
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
        if names is not None and stem not in names:
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
            heading = next((line[2:].strip() for line in page.read_text(encoding="utf-8").splitlines()
                            if line.startswith("# ")), page.stem)
            label = heading.replace("[", r"\[").replace("]", r"\]")
            lines.append(f"- [{label}]({base}{page.stem})")
        sections.append(title + "\n\n" + "\n".join(lines))
    return "\n\n".join(sections) + "\n"


def export_wiki(source, output, repository):
    pages = sorted(source.glob("*.md"))
    names = {page.stem for page in pages}
    rendered = {page.name: rewrite_links(page.read_text(encoding="utf-8"), names, repository) for page in pages}
    rendered["_Sidebar.md"] = sidebar(pages, repository)
    output.mkdir(parents=True, exist_ok=True)
    for name in rendered:
        if (output / name).is_symlink():
            raise ValueError(f"Refusing symlink output: {name}")
    for name, content in rendered.items():
        (output / name).write_text(content, encoding="utf-8")
    return len(rendered)


def comparison_text(page, repository):
    # Old links in the checkout may point at retired pages. Compare their destinations too.
    text = rewrite_links(page.read_text(encoding="utf-8", errors="surrogateescape"), None, repository)
    base = f"https://github.com/{repository}/"
    for alias, canonical in (("wiki/Home.zh-CN", "wiki/Home"), ("blob/main/README.zh-CN.md", "blob/main/README.md")):
        text = re.sub(re.escape(f"]({base}{alias}") + r"(?=[)#])", f"]({base}{canonical}", text)
    return "\n".join(line.rstrip(" \t") for line in text.split("\n")).rstrip("\n")


def live_pages(directory):
    for entry in directory.iterdir():
        if entry.name == ".git":
            continue
        if not entry.is_symlink() and entry.is_dir():
            yield from live_pages(entry)
        elif entry.suffix == ".md":
            yield entry


def compare_export(output, live, repository):
    expected = {page.name for page in output.glob("*.md")}
    actual = {page.relative_to(live).as_posix() for page in live_pages(live)}
    different = set()
    for name in expected & actual:
        page = live / name
        if (page.is_symlink() or not page.is_file()
                or comparison_text(page, repository) != comparison_text(output / name, repository)):
            different.add(name)
    missing, extra = expected - actual, actual - expected
    for label, names in (("Missing", missing), ("Extra", extra), ("Different", different)):
        for name in sorted(names):
            print(f"{label}: {name}")
    if missing or extra or different:
        return 1
    print(f"All {len(expected)} exported Wiki pages match.")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", help=f"OWNER/REPOSITORY (compare defaults to {DEFAULT_REPOSITORY})")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--output", type=Path, help="write the export to this directory")
    mode.add_argument("--compare", type=Path, metavar="LIVE_DIR", help="check a local Wiki checkout for drift")
    args = parser.parse_args()
    if args.output and args.repository is None:
        parser.error("--repository is required with --output")
    repository = args.repository if args.repository is not None else DEFAULT_REPOSITORY
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        parser.error("Use OWNER/REPOSITORY")
    source = Path(__file__).resolve().parents[1] / "wiki"
    if args.compare:
        live = args.compare.expanduser().resolve()
        if not live.is_dir():
            parser.error(f"Choose an existing Wiki checkout directory: {live}")
        with tempfile.TemporaryDirectory(prefix="wiki-export-") as directory:
            output = Path(directory)
            export_wiki(source, output, repository)
            return compare_export(output, live, repository)
    output = args.output.expanduser().resolve()
    if output == source or source in output.parents:
        parser.error("Choose an output outside the source Wiki directory")
    count = export_wiki(source, output, repository)
    print(f"Exported {count} local pages; inspect the diff before pushing.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
