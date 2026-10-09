#!/usr/bin/env python3
"""Local-only regression checks for bilingual Wiki export and navigation."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("wiki_export", ROOT / "deploy/export-wiki.py")
EXPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXPORT)


class WikiExportTests(unittest.TestCase):
    def test_wiki_and_readme_style_links_keep_fragments(self):
        names = {"Home", "Home.en", "Home.zh-CN", "AI.zh-CN"}
        text = "[首页](Home.md) [English](wiki/Home.en.md#start) [AI](./wiki/AI.zh-CN.md#配置) [旧入口](./Home.zh-CN.md)"
        rendered = EXPORT.rewrite_links(text, names, "owner/project")
        self.assertEqual(rendered, "[首页](https://github.com/owner/project/wiki/Home) [English](https://github.com/owner/project/wiki/Home.en#start) [AI](https://github.com/owner/project/wiki/AI.zh-CN#配置) [旧入口](https://github.com/owner/project/wiki/Home.zh-CN)")

    def test_repository_readme_and_external_links(self):
        text = "[README](../README.en.md#install) [web](https://example.com/page.md) [source](../source.md)"
        self.assertEqual(EXPORT.rewrite_links(text, {"Home"}, "owner/project"),
                         "[README](https://github.com/owner/project/blob/main/README.en.md#install) [web](https://example.com/page.md) [source](../source.md)")
        with self.assertRaisesRegex(ValueError, "Unknown Wiki page"):
            EXPORT.rewrite_links("[missing](wiki/Missing.md)", {"Home"}, "owner/project")

    def test_export_keeps_compatibility_page_and_chinese_first(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "deploy").mkdir()
            (root / "wiki").mkdir()
            shutil.copy2(ROOT / "deploy/export-wiki.py", root / "deploy/export-wiki.py")
            content = {"Home.md": "# 中文首页\n[English](Home.en.md)\n",
                       "Home.en.md": "# English home\n[中文](Home.md)\n",
                       "Home.zh-CN.md": "# 兼容入口\n[中文](Home.md)\n",
                       "AI.md": "# AI guide\n", "AI.zh-CN.md": "# AI 配置\n"}
            for name, text in content.items():
                (root / "wiki" / name).write_text(text)
            out = root / "export"
            result = subprocess.run([sys.executable, str(root / "deploy/export-wiki.py"),
                                     "--repository", "owner/project", "--output", str(out)],
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            side = (out / "_Sidebar.md").read_text()
            zh, en = side.split("\n\nEnglish\n\n")
            self.assertTrue(zh.startswith("简体中文\n\n- [中文首页]"))
            self.assertIn("/wiki/Home)", zh)
            self.assertNotIn("/wiki/Home.en", zh)
            self.assertTrue(en.startswith("- [English home]"))
            self.assertNotIn("/wiki/Home.zh-CN", side)
            self.assertIn("/wiki/Home)", (out / "Home.zh-CN.md").read_text())
            self.assertEqual((root / "wiki/Home.md").read_text(), content["Home.md"])

    def test_live_repository_navigation_targets_exist(self):
        names = {page.stem for page in (ROOT / "wiki").glob("*.md")}
        for page in (ROOT / "wiki").glob("*.md"):
            EXPORT.rewrite_links(page.read_text(), names, "owner/project")
        self.assertIn("简体中文", (ROOT / "wiki/Home.md").read_text())
        self.assertIn("English", (ROOT / "wiki/Home.en.md").read_text())
        for filename in ["README.md", "README.en.md"]:
            for match in EXPORT.LOCAL_MARKDOWN_LINK.finditer((ROOT / filename).read_text()):
                if match["path"].startswith("wiki/"):
                    self.assertIn(Path(match["path"]).stem, names)


if __name__ == "__main__":
    unittest.main()
