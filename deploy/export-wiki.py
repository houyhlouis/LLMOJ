#!/usr/bin/env python3
"""Export local Wiki pages; no network or Git operations."""
# SPDX-License-Identifier: MIT
import argparse
from pathlib import Path
import re


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
    base = f"https://github.com/{args.repository}/wiki/"
    pattern = re.compile(r"\]\(([A-Za-z0-9_.-]+)\.md(#[^)]*)?\)")
    names = {page.stem for page in pages}
    rendered = {}
    for page in pages:
        def link(match):
            if match[1] not in names:
                raise ValueError(f"Unknown Wiki page: {match[1]}")
            return f"]({base}{match[1]}{match[2] or ''})"
        rendered[page.name] = pattern.sub(link, page.read_text())
    english = [page for page in pages if not page.stem.endswith(".zh-CN")]
    chinese = [page for page in pages if page.stem.endswith(".zh-CN")]
    rendered["_Sidebar.md"] = "English\n\n" + "\n".join(
        f"- [{page.stem}]({base}{page.stem})" for page in english
    ) + "\n\n简体中文\n\n" + "\n".join(
        f"- [{page.stem.removesuffix('.zh-CN')}]({base}{page.stem})" for page in chinese
    ) + "\n"
    output.mkdir(parents=True, exist_ok=True)
    for name in rendered:
        if (output / name).is_symlink():
            raise ValueError(f"Refusing symlink output: {name}")
    for name, content in rendered.items():
        (output / name).write_text(content)
    print(f"Exported {len(rendered)} local pages; inspect the diff before pushing.")


if __name__ == "__main__":
    main()
