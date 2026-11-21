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


class WikiCheckoutTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.source = self.root / "wiki"
        self.live = self.root / "live"
        self.command = self.root / "deploy/export-wiki.py"
        self.source.mkdir()
        self.command.parent.mkdir()
        shutil.copy2(ROOT / "deploy/export-wiki.py", self.command)
        self.content = {"Home.md": "# 中文首页\n[English](Home.en.md)\n",
                        "Home.en.md": "# English home\n[中文](Home.md)\n",
                        "Home.zh-CN.md": "# 兼容入口\n[中文](Home.md)\n",
                        "AI.md": "# AI guide\n[Start](./wiki/Home.zh-CN.md#intro) [Read](../README.zh-CN.md#help)\n",
                        "AI.zh-CN.md": "# AI 配置\n"}
        for name, text in self.content.items():
            (self.source / name).write_text(text)

    def run_tool(self, *args):
        return subprocess.run([sys.executable, self.command, *args], text=True, capture_output=True)

    def export(self, repository="owner/project"):
        result = self.run_tool("--repository", repository, "--output", self.live)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_export_keeps_compatibility_page_and_chinese_first(self):
        self.export()
        side = (self.live / "_Sidebar.md").read_text()
        zh, en = side.split("\n\nEnglish\n\n")
        self.assertTrue(zh.startswith("简体中文\n\n- [中文首页]"))
        self.assertIn("/wiki/Home)", zh)
        self.assertNotIn("/wiki/Home.en", zh)
        self.assertTrue(en.startswith("- [English home]"))
        self.assertNotIn("/wiki/Home.zh-CN", side)
        self.assertIn("/wiki/Home)", (self.live / "Home.zh-CN.md").read_text())
        self.assertEqual((self.source / "Home.md").read_text(), self.content["Home.md"])

    def test_compare_accepts_equivalent_links_aliases_and_whitespace(self):
        self.export("houyhlouis/LLMOJ")
        text = "# AI guide   \r\n[Start](Home.md#intro) [Read](../README.md#help)\t\r\n\r\n"
        page = self.live / "AI.md"
        page.write_bytes(text.encode())
        (self.live / ".git").mkdir()
        (self.live / ".git/ignored.md").write_text("Git metadata")
        result = self.run_tool("--compare", self.live)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(page.read_bytes(), text.encode())
        self.assertEqual((self.source / "AI.md").read_text(), self.content["AI.md"])

    def test_compare_reports_missing_extra_and_different_pages_together(self):
        self.export()
        (self.live / "Home.zh-CN.md").unlink()
        (self.live / "old").mkdir()
        (self.live / "old/Guide.md").write_text("# Old guide\n")
        (self.live / "_Sidebar.md").write_text("Previous navigation\n")
        (self.live / "AI.md").write_text(self.content["AI.md"].replace("#intro", "#other"))
        (self.live / "Home.en.md").write_text("# English home\n[中文](Missing.md)\n")
        result = self.run_tool("--repository", "owner/project", "--compare", self.live)
        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        self.assertEqual(result.stdout.splitlines(), [
            "Missing: Home.zh-CN.md", "Extra: old/Guide.md", "Different: AI.md",
            "Different: Home.en.md", "Different: _Sidebar.md",
        ])
        self.assertFalse((self.live / "Home.zh-CN.md").exists())
        self.assertTrue((self.live / "old/Guide.md").exists())

    def test_compare_checks_the_repository_in_link_targets(self):
        self.export()
        page = self.live / "AI.md"
        page.write_text(page.read_text().replace("/owner/project/", "/other/project/"))
        result = self.run_tool("--repository", "owner/project", "--compare", self.live)
        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        self.assertEqual(result.stdout.splitlines(), ["Different: AI.md"])

    def test_compare_requires_an_existing_live_directory(self):
        result = self.run_tool("--compare", self.live)
        self.assertEqual(result.returncode, 2)
        self.assertIn(str(self.live), result.stderr)
        self.assertFalse(self.live.exists())


if __name__ == "__main__":
    unittest.main()
