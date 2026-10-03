import { AiError } from "./ai.types";
import { detectAiFileIo } from "./ai-file-io";

/** Source-page badges belong to judge metadata, never to editable statement sections. */
export function detectImportFileIoEvidence(evidence: string) {
  if (typeof evidence !== "string" || evidence.length > 1000000) throw new AiError("INVALID_AI_FILE_IO");
  const declarations: string[] = [];
  // A Filename badge on SYZOJ/Hydro pages specifies the common .in/.out basename.
  // Restrict this to a whole metadata line; attachment paths and incidental mentions do not qualify.
  let fence: { marker: string; length: number } | null = null;
  let ignoredSectionLevel: number | null = null;
  const visibleEvidence: string[] = [];
  const contextHeading = /(?:sample|example|attachment|download|local[ -]?(?:test|file)|样例|示例|附件|下载|本地测试)/i;
  for (const line of evidence.split(/\r?\n/)) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim())
        fence = null;
      continue;
    }
    if (delimiter) {
      fence = { marker: delimiter[1][0], length: delimiter[1].length };
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    const plainHeading = line.trim();
    if (heading) {
      const level = heading[1].length;
      if (ignoredSectionLevel != null && level <= ignoredSectionLevel) ignoredSectionLevel = null;
      if (ignoredSectionLevel == null && contextHeading.test(heading[2])) ignoredSectionLevel = level;
    } else if (
      /^(?:(?:sample|example)(?:\s+(?:files?|data|input|output))?|attachments?|downloads?|local[ -]?test(?:ing)?|样例(?:文件|数据|输入|输出)?|示例(?:文件|数据)?|附件|下载|本地测试)\s*[:：]?$/i.test(
        plainHeading.replace(/^(?:\*\*|__)|(?:\*\*|__)$/g, "")
      )
    ) {
      ignoredSectionLevel = 7;
    }
    if (ignoredSectionLevel != null) continue;
    visibleEvidence.push(line);
    const match = line
      .trim()
      .replace(/\*\*/g, "")
      .match(/^(?:filename|file\s*name|file\s*io|文件名)\s*[:：=]\s*`?([^\s`]+)`?\s*$/i);
    if (!match) continue;
    const base = match[1];
    if (/^(?:stdio|standard|none|null)$/i.test(base)) {
      declarations.push("Use standard input and standard output.");
    } else {
      if (!/^[A-Za-z0-9_.-]+$/.test(base) || base === "." || base === "..") throw new AiError("INVALID_AI_FILE_IO");
      declarations.push(`Input file: ${base}.in\nOutput file: ${base}.out`);
    }
  }
  return detectAiFileIo([
    {
      contentSections: [
        {
          type: "Text",
          sectionTitle: "I/O evidence",
          text: `${visibleEvidence.join("\n")}\n${declarations.join("\n")}`
        }
      ]
    }
  ]);
}
