import type { ProblemContentSection } from "../problem/problem-content.interface";

/** Normalize only explicit LaTeX delimiters outside Markdown code. */
export function normalizeAiMarkdown(value: string): string {
  const math = (text: string) =>
    text
      .replace(/\\\[([\s\S]*?)\\\]/g, (_match, formula) => `\n$$\n${formula.trim()}\n$$\n`)
      .replace(/\\\(([^\n]*?)\\\)/g, (_match, formula) => `$${formula.trim()}$`);
  const plain = (text: string) => {
    // Backtick spans may contain shorter runs (or newlines); only an equal run closes them.
    const spans = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
    let out = "";
    let at = 0;
    for (const match of text.matchAll(spans)) {
      out += math(text.slice(at, match.index)) + match[0];
      at = match.index! + match[0].length;
    }
    return out + math(text.slice(at));
  };
  let out = "";
  let pending = "";
  let fence: string = null;
  for (const line of value.match(/[^\n]*\n|[^\n]+$/g) || []) {
    if (fence) {
      out += line;
      const close = line.match(/^ {0,3}(`+|~+)\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
    } else {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)/);
      if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
        out += plain(pending) + line;
        pending = "";
        [, fence] = open;
      } else pending += line;
    }
  }
  return out + plain(pending);
}

/** Keep all scoring/range declarations together, without inventing constraints. */
export function normalizeAiSections<T extends { locale: string; contentSections: ProblemContentSection[] }>(
  content: T
) {
  const title = content.locale === "zh_CN" ? "数据范围与提示" : "Limits and Hints";
  const isLimits = (s: ProblemContentSection) =>
    s.type === "Text" &&
    /^(?:limits?(?:\s+and\s+hints?)?|constraints?|hints?|subtasks?|scoring|data\s+range|数据范围(?:与提示)?|数据范围和提示|限制(?:与提示)?|提示|子任务|评分(?:标准|规则)?)$/i.test(
      String(s.sectionTitle || "").trim()
    );
  const sections = content.contentSections.map(s => ({
    ...s,
    ...(typeof s.text === "string" ? { text: normalizeAiMarkdown(s.text) } : {})
  }));
  const limits = sections.filter(isLimits);
  if (!limits.length) return { ...content, contentSections: sections };
  const combined = limits
    .map(s => {
      const text = (s.text || "").trim();
      if (!text) return "";
      return /subtasks?|子任务|scoring|评分/i.test(s.sectionTitle) ? `### ${s.sectionTitle}\n\n${text}` : text;
    })
    .filter(Boolean)
    .join("\n\n");
  const result = [];
  let placed = false;
  for (const section of sections) {
    if (!isLimits(section)) result.push(section);
    else if (!placed) {
      result.push({ ...section, sectionTitle: title, text: combined });
      placed = true;
    }
  }
  return { ...content, contentSections: result };
}

export const AI_MARKDOWN_RULES =
  "Use Markdown math with $...$ inline and $$...$$ display delimiters. Never use \\( ... \\) or \\[ ... \\] delimiters, and never put LaTeX formulas in bare parentheses. Preserve code fences and escape backslashes exactly once in JSON. Put all subtask constraints, percentages/scores and data ranges in the Limits and Hints section (数据范围与提示 in Chinese), not in Description or a separate Subtasks section.";
