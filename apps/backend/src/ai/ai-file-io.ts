import { AiError } from "./ai.types";

import type { AiStatementText } from "./ai.types";

import { ProblemJudgeInfoTraditional } from "../problem-type/types/traditional/problem-judge-info.interface";
import { validateMetaAndSubtasks } from "../problem-type/common/meta-and-subtasks";

type FileIo = ProblemJudgeInfoTraditional["fileIo"];

function checkedFileIo(value: unknown): FileIo {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as FileIo).inputFilename !== "string" ||
    typeof (value as FileIo).outputFilename !== "string"
  )
    throw new AiError("INVALID_AI_FILE_IO");
  const result = {
    inputFilename: (value as FileIo).inputFilename,
    outputFilename: (value as FileIo).outputFilename
  };
  for (const filename of Object.values(result)) {
    // eslint-disable-next-line no-control-regex -- Reject control bytes in untrusted filenames.
    if (!filename.trim() || Buffer.byteLength(filename) > 255 || /[\x00-\x1f\x7f]/.test(filename))
      throw new AiError("INVALID_AI_FILE_IO");
  }
  if (result.inputFilename === result.outputFilename) throw new AiError("INVALID_AI_FILE_IO");
  try {
    // Use the same filename validation as normal problem judging configuration.
    validateMetaAndSubtasks({ fileIo: result }, [], {
      enableTimeMemoryLimit: false,
      enableFileIo: true,
      enableInputFile: false,
      enableOutputFile: false,
      enableUserOutputFilename: false
    });
  } catch {
    throw new AiError("INVALID_AI_FILE_IO");
  }
  return result;
}

export interface AiFileIoEvidence {
  kind: "standard" | "named" | "unspecified";
  fileIo: FileIo | null;
}

type Side = "input" | "output";
const sides: Side[] = ["input", "output"];
const contextOnly =
  /\b(?:samples?|examples?|attachments?|archives?|local\s+test(?:ing)?|test\s+data)\b(?!\.[\p{L}\p{N}_-])|样例|示例|附件|压缩包|本地测试|测试数据/iu;
const labels: Record<Side, string> = {
  input: String.raw`(?:input\s*(?:(?:format\s*)?\(?\s*file(?:\s*name)?|filename)|输入(?:文件(?:名称|名)?|档案))`,
  output: String.raw`(?:output\s*(?:(?:format\s*)?\(?\s*file(?:\s*name)?|filename)|输出(?:文件(?:名称|名)?|档案))`
};
const isLabel = (value: string, side: Side) => new RegExp(`^${labels[side]}\\s*[:：]?\\s*$`, "iu").test(value.trim());

function statementText(value: unknown): string {
  // Ignore complete and unfinished Markdown fences, including longer closing fences.
  let fence: { marker: string; length: number } | null = null;
  let ignoredHeadingLevel: number | null = null;
  const sourceLines = String(value || "").split(/\r?\n/);
  const lines = sourceLines.filter((line, index) => {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim())
        fence = null;
      return false;
    }
    if (delimiter) {
      fence = { marker: delimiter[1][0], length: delimiter[1].length };
      return false;
    }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    const setext = !heading && /^ {0,3}\S/.test(line) ? sourceLines[index + 1]?.match(/^ {0,3}(=+|-+)\s*$/) : null;
    if (heading || setext) {
      const level = heading ? heading[1].length : setext[1][0] === "=" ? 1 : 2;
      const title = heading ? heading[2] : line;
      if (ignoredHeadingLevel != null && level <= ignoredHeadingLevel) ignoredHeadingLevel = null;
      // A nested contextual heading must not shorten its enclosing ignored section.
      if (ignoredHeadingLevel == null && contextOnly.test(title)) ignoredHeadingLevel = level;
    }
    return ignoredHeadingLevel == null;
  });
  return (
    lines
      .join("\n")
      // Source links do not declare the submission's I/O contract.
      .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gi, "$1")
      .replace(/https?:\/\/[^\s<>]+/gi, "")
      .replace(/\*\*/g, "")
  );
}

function declaredFilename(value: string): string | null {
  const rest = value.trim().replace(/^(?:(?:is|为|是)\s*)?[:：=—–-]?\s*/iu, "");
  if (!rest || /^(?:not\b|never\b|不是|并非|不得|不能|不使用)/iu.test(rest)) return null;
  const delimiters: Record<string, string> = { "`": "`", '"': '"', "'": "'", "“": "”", "‘": "’", "（": "）", "(": ")" };
  const quoted = !!delimiters[rest[0]];
  let candidate: string | undefined;
  if (quoted) {
    const end = rest.indexOf(delimiters[rest[0]], 1);
    if (end < 1) return null;
    candidate = rest.slice(1, end);
    // A parenthesized filename may itself use Markdown or localized quotation marks.
    while (delimiters[candidate[0]] && candidate.endsWith(delimiters[candidate[0]])) candidate = candidate.slice(1, -1);
  } else {
    const raw = rest.match(/^[^\s`"'“”‘’（）()<>{}[\]|:,;!?，。；：]+/u)?.[0];
    candidate = raw === "." || raw === ".." ? raw : raw?.replace(/\.+$/, "");
  }
  if (!candidate) return null;
  // A sentence about the input file's contents is not a filename declaration.
  // Extensionless filenames require quotes or a complete, isolated value.
  const isolated = /^[`"'“‘（(]*[^\s`"'“”‘’（）()<>{}[\]|:,;!?，。；：]+[`"'”’）)]*[.。]?\s*$/u.test(rest);
  const filenameLike = /\.[\p{L}\p{N}_-]+$/u.test(candidate) || /[\\/]/u.test(candidate);
  if (!quoted && !filenameLike && !isolated) return null;
  if (
    !quoted &&
    (/^\d+$/.test(candidate) ||
      /^(?:contains?|consists?|has|have|includes?|first|one|the|a|an|n|m|input|output|none|null|如下|包含|包括|共有|第一行|一个整数)$/iu.test(
        candidate
      ))
  )
    return null;
  if (!quoted && !filenameLike && /[\u3400-\u9fff]/u.test(candidate)) return null;
  return candidate;
}

/** Detect evidence in the statement alone; callers can distinguish explicit stdio from no evidence. */
export function detectAiFileIo(statements: AiStatementText[]): AiFileIoEvidence {
  const sections = (statements || [])
    .flatMap(content => content.contentSections || [])
    .filter(section => section.type === "Text" && !contextOnly.test(section.sectionTitle || ""));
  const texts = sections.map(section => `${statementText(section.sectionTitle)}\n${statementText(section.text)}`);
  const instructions = texts.join("\n").split(/[.!?。！？;；\n，]|,\s*(?:but\s+)?|\bbut\b/iu);
  const standard = new Set<Side>();
  for (const side of sides) {
    const pattern =
      side === "input"
        ? /\bstandard\s+input\b|\bstandard\s+output\s*(?:\/|and|&)\s*(?:standard\s+)?input\b|\bstandard\s+i\s*\/\s*o\b|\b(?:use|read(?:s|ing)?(?:\s+from)?)\s*`?stdin\b|标准输入/giu
        : /\bstandard\s+output\b|\bstandard\s+input\s*(?:\/|and|&)\s*(?:standard\s+)?output\b|\bstandard\s+i\s*\/\s*o\b|\b(?:use|write(?:s|ing)?(?:\s+to)?|and)\s*`?stdout\b|标准输出/giu;
    if (
      instructions.some(
        instruction =>
          !contextOnly.test(instruction) &&
          [...instruction.matchAll(pattern)].some(match => {
            const before = instruction.slice(0, match.index);
            const after = instruction.slice((match.index || 0) + match[0].length);
            const negatedBefore =
              /\b(?:not|never|without|avoid|forbid(?:den)?|prohibit(?:ed)?|don['’]t|mustn['’]t|shouldn['’]t|cannot|can['’]t)\b|不要|不得|禁止|不能|不可|不应|不使用|不采用|无需/iu.test(
                before
              );
            const negatedAfter = /\b(?:is|are|must|should|can|will)\s+(?:not|never)\b|禁止|不可|不能|不得|不应/iu.test(
              after
            );
            return !negatedBefore && !negatedAfter;
          })
      )
    )
      standard.add(side);
  }
  if (standard.size === 2) return { kind: "standard", fileIo: null };
  const names: Record<Side, Set<string>> = { input: new Set(), output: new Set() };
  const add = (side: Side, value: string) => {
    if (/^(?:standard\s+input|stdin|标准输入)\s*[.。]?$/iu.test(value.trim()) && side === "input") {
      standard.add(side);
      return;
    }
    if (/^(?:standard\s+output|stdout|标准输出)\s*[.。]?$/iu.test(value.trim()) && side === "output") {
      standard.add(side);
      return;
    }
    const filename = declaredFilename(value);
    if (filename) {
      if (filename.toLowerCase() === (side === "input" ? "stdin" : "stdout")) standard.add(side);
      else names[side].add(filename);
    }
  };
  for (const text of texts) {
    const lines = text.split(/\r?\n/);
    let headers: (Side | null)[] | null = null;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim().replace(/^#{1,6}\s+/, "");
      if (!line || contextOnly.test(line)) {
        headers = null;
        continue;
      }
      // Direct contestant instructions may declare both files in one sentence.
      // Require imperative read/write clauses and filename-shaped values; never infer
      // names from a story, sample/archive prose, negated directions, or source code.
      const prefix = String.raw`(?:(?:please\s+)?(?:you\s+(?:must|should)\s+|(?:your\s+)?program\s+(?:must|should)\s+)?)`;
      for (const clause of line.split(/;\s*|\bbut\b|\.\s+(?=(?:read|write)\b)/iu)) {
        if (
          !new RegExp(`^${prefix}(?:read|write)\\s+`, "iu").test(clause.trim()) ||
          /\b(?:not|never|without|avoid|don['’]t|mustn['’]t|shouldn['’]t|cannot|can['’]t)\b/iu.test(clause)
        )
          continue;
        for (const directive of clause.trim().split(/\s+(?:and|then)\s+/iu)) {
          for (const side of sides) {
            const verb = side === "input" ? "read" : "write";
            const direction = side === "input" ? "from" : "to";
            const role = side === "input" ? "input|data" : "output|answer|result";
            const match = directive.match(
              new RegExp(
                `^${prefix}${verb}\\s+(?:(?:all\\s+)?(?:the\\s+)?(?:${role})\\s+)?(?:${direction}\\s+)?(.+)$`,
                "iu"
              )
            );
            const name = match && declaredFilename(match[1]);
            if (name && (/\.[\p{L}\p{N}_-]+$/u.test(name) || /[\\/]/u.test(name))) names[side].add(name);
          }
        }
      }
      if (line.includes("|")) {
        const cells = line
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map(cell => cell.trim());
        if (cells.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
        const labelsInRow = cells.map(cell => sides.find(side => isLabel(cell, side)) || null);
        if (labelsInRow.filter(Boolean).length >= 2) {
          headers = labelsInRow;
          continue;
        }
        if (headers) {
          headers.forEach((side, column) => {
            if (side && cells[column]) add(side, cells[column]);
          });
          continue;
        }
        if (cells.length === 2 && labelsInRow[0]) add(labelsInRow[0], cells[1]);
        continue;
      }
      headers = null;
      // OCR often keeps both file headers on one line. Split only after the original
      // line has passed sample/attachment filtering, so a trailing sample header is
      // never promoted to an independent submission requirement.
      const declarationParts = line.split(
        new RegExp(
          `(?:\\s+|[.,，;；。]\\s*)(?=(?:the\\s+)?(?:${labels.input}|${labels.output})\\s*(?:[:：=]|[\\x60"'“‘（(]|is\\b|为|是))`,
          "giu"
        )
      );
      for (const declaration of declarationParts)
        for (const side of sides) {
          const match = declaration.match(new RegExp(`^(?:the\\s+)?${labels[side]}(.*)$`, "iu"));
          if (match) {
            let rest = match[1].trim();
            if (!rest || /^[:：]$/.test(rest)) rest = (lines[index + 1] || "").trim();
            if (!contextOnly.test(rest)) add(side, rest);
            continue;
          }
          // Compact headers such as “Input: task.in” must contain an actual filename.
          const compact = declaration.match(
            new RegExp(`^(?:${side}|${side === "input" ? "输入" : "输出"})\\s*[:：—–-]\\s*(.+)$`, "iu")
          );
          if (compact && /\.[\p{L}\p{N}_-]+[`"'”’）)]*[.。]?\s*$/u.test(compact[1])) add(side, compact[1]);
        }
    }
  }
  if (standard.size === 2) return { kind: "standard", fileIo: null };
  if (names.input.size > 1 || names.output.size > 1) throw new AiError("INVALID_AI_FILE_IO");
  const inputFilename = [...names.input][0];
  const outputFilename = [...names.output][0];
  if ((inputFilename || outputFilename) && (!inputFilename || !outputFilename || standard.size))
    throw new AiError("UNVERIFIED_AI_FILE_IO");
  // Many statements (including AtCoder) explicitly name only Standard Input and
  // describe output as "Print ...". With no named-file declaration, either side
  // is sufficient stdio evidence; mixed named/standard contracts were rejected above.
  if (!inputFilename && !outputFilename) return { kind: standard.size ? "standard" : "unspecified", fileIo: null };
  return { kind: "named", fileIo: checkedFileIo({ inputFilename, outputFilename }) };
}

/** Judge Settings are authoritative, including an explicitly selected standard-I/O null value. */
export function resolveAiFileIo(
  judgeInfo: { fileIo?: FileIo },
  statements: AiStatementText[],
  proposal?: unknown
): FileIo | null {
  if (judgeInfo && Object.prototype.hasOwnProperty.call(judgeInfo, "fileIo"))
    return judgeInfo.fileIo == null ? null : checkedFileIo(judgeInfo.fileIo);
  const detected = detectAiFileIo(statements);
  if (proposal != null) {
    const proposed = checkedFileIo(proposal);
    if (
      detected.kind !== "standard" &&
      (!detected.fileIo ||
        proposed.inputFilename !== detected.fileIo.inputFilename ||
        proposed.outputFilename !== detected.fileIo.outputFilename)
    )
      throw new AiError("UNVERIFIED_AI_FILE_IO");
  }
  return detected.fileIo;
}
