import { AiError } from "./ai.types";
import { normalizeAiMarkdown } from "./ai-content";

import { Locale } from "../common/locale.type";
import { ProblemContentSectionType } from "../problem/problem-content.interface";

export type AiEditorLocale = Locale;
export interface AiEditorSample {
  inputData: string;
  outputData: string;
}
export interface AiEditorSection {
  type: ProblemContentSectionType;
  sectionTitle: string;
  text: string;
  sampleId?: number;
}
export interface AiEditorLocalizedContent {
  locale: AiEditorLocale;
  title: string;
  contentSections: AiEditorSection[];
}
export interface AiEditorStatement {
  localizedContents: AiEditorLocalizedContent[];
  samples: AiEditorSample[];
}

/** Model-facing fields. Headings and sample references belong to the editor, not the model. */
export interface AiEditorFields {
  locale: AiEditorLocale;
  title: string;
  description: string;
  input: string;
  output: string;
  limitsAndHints: string;
}

type Field = "description" | "input" | "output" | "limitsAndHints";
const fields: Field[] = ["description", "input", "output", "limitsAndHints"];
const titles: Record<AiEditorLocale, Record<Field | "sample", string>> = {
  zh_CN: {
    description: "题目描述",
    input: "输入格式",
    output: "输出格式",
    limitsAndHints: "数据范围与提示",
    sample: "样例"
  },
  en_US: {
    description: "Description",
    input: "Input",
    output: "Output",
    limitsAndHints: "Limits And Hints",
    sample: "Sample"
  }
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const own = (value: object, name: string) => Object.prototype.hasOwnProperty.call(value, name);
function fail(): never {
  throw new AiError("INVALID_AI_STATEMENT");
}

function headingKey(title: string): string {
  return title
    .normalize("NFKC")
    .trim()
    .replace(/^(?:\d+|[一二三四五六七八九十]+)[.、．)）]\s*/, "")
    .replace(/[\s*_#`~:：()[\]【】（）「」{}&/\\-]/g, "")
    .toLowerCase();
}
function heading(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/[\\`*_{}[\]<>#]/g, "\\$&");
}

/** Only dedicated metadata headings are discarded; prose inside valid statement fields is retained. */
function isMetadata(key: string): boolean {
  return /^(?:tags?|problemtags?|algorithmtags?|keywords?|标签|题目标签|算法标签|知识点|time(?:limit)?|timelimits?|时间限制|时限|memory(?:limit)?|memorylimits?|内存限制|空间限制|timememorylimits?|timeandmemorylimits?|resourcelimits?|资源限制|judgelimits?|judgesettings?|评测限制|评测配置|inputfile(?:name)?|outputfile(?:name)?|inputoutputfiles?|inputoutputmethod|iomethod|fileio|io|输入文件(?:名)?|输出文件(?:名)?|输入输出文件(?:名)?|输入输出方式|输入输出方法|filename|文件名|metadata|probleminfo(?:rmation)?|problemproperties|题目信息|题目属性|source|origin|originalproblem|题目来源|来源|原题|difficulty|难度|problemtype|题目类型)$/.test(
    key
  );
}
function ioMetadataOnly(value: string): boolean {
  const lines = value
    .split(/\r?\n/)
    .map(line => line.trim().replace(/[*`"'“”‘’]/g, ""))
    .filter(Boolean);
  if (!lines.length) return true;
  return lines.every(line => {
    const content = line
      .replace(
        /^(?:(?:input|output)(?:\s*file(?:name)?)?|输入(?:文件(?:名)?)?|输出(?:文件(?:名)?)?|file\s*io|filename|文件名)\s*[:：=]\s*/i,
        ""
      )
      .trim();
    return /^(?:stdio|stdin|stdout|standard\s+(?:input|output)(?:\s*(?:and|[&,/])\s*(?:standard\s+)?(?:input|output))?|标准(?:输入|输出)(?:[和与、/]*(?:标准)?(?:输入|输出))?|[A-Za-z0-9_.-]+\.(?:in|out|inp|ans|txt|dat)(?:\s*[/,;，；]\s*[A-Za-z0-9_.-]+\.(?:in|out|inp|ans|txt|dat))?)[.。]?$/i.test(
      content
    );
  });
}
function classify(title: string, content: string): { field: Field; keepHeading?: boolean } | null {
  const key = headingKey(title);
  // These labels also commonly contain real format rules. Do not discard prose just
  // because its heading can also describe judge metadata in another document.
  if (
    /^(?:inputfile(?:name)?|outputfile(?:name)?|inputoutputfiles?|inputoutputmethod|iomethod|fileio|io|输入文件(?:名)?|输出文件(?:名)?|输入输出文件(?:名)?|输入输出方式|输入输出方法)$/.test(
      key
    )
  ) {
    if (ioMetadataOnly(content)) return null;
    if (/^(?:inputfile|输入文件)/.test(key)) return { field: "input" };
    if (/^(?:outputfile|输出文件)/.test(key)) return { field: "output" };
    return { field: "limitsAndHints", keepHeading: true };
  }
  if (isMetadata(key)) return null;
  if (
    /^(?:description|problemdescription|problemstatement|statement|problem|task|题目描述|题目说明|题面|描述)$/.test(key)
  )
    return { field: "description" };
  if (/^(?:background|problembackground|story|题目背景|背景)$/.test(key))
    return { field: "description", keepHeading: true };
  if (/^(?:input|inputformat|inputspecification|inputdescription|输入|输入格式|输入说明|输入描述)$/.test(key))
    return { field: "input" };
  if (/^(?:output|outputformat|outputspecification|outputdescription|输出|输出格式|输出说明|输出描述)$/.test(key))
    return { field: "output" };
  if (
    /^(?:limits?(?:andhints?)?|constraints?|hints?|notes?|explanation|datarange|数据范围(?:与提示|和提示)?|数据规模(?:与约定)?|限制(?:与提示)?|提示|说明|备注|范围与提示)$/.test(
      key
    )
  )
    return { field: "limitsAndHints" };
  // Subtask tables, explanations and any other meaningful notes stay within the last preset field.
  return { field: "limitsAndHints", keepHeading: true };
}

/**
 * AI-only adapter to the original editor template. Do not use this for manual saves:
 * custom user section names and order are intentional. Extract judge/tag/source metadata
 * from the raw response before calling; this return value contains statement data only.
 * Accepts fixed AiEditorFields and historic contentSections to resume persisted AI jobs.
 */
export function canonicalizeAiEditorStatement(value: unknown): AiEditorStatement {
  if (
    !record(value) ||
    !Array.isArray(value.localizedContents) ||
    !value.localizedContents.length ||
    value.localizedContents.length > 2
  )
    fail();
  if (!Array.isArray(value.samples) || value.samples.length > 100) throw new AiError("INVALID_AI_SAMPLE");
  const samples: AiEditorSample[] = value.samples.map(sample => {
    if (
      !record(sample) ||
      typeof sample.inputData !== "string" ||
      typeof sample.outputData !== "string" ||
      sample.inputData.length + sample.outputData.length > 1000000
    )
      throw new AiError("INVALID_AI_SAMPLE");
    // Sample bytes must remain exact: Markdown normalization only applies to statement prose.
    return { inputData: sample.inputData, outputData: sample.outputData };
  });
  const locales = new Set<string>();
  const localizedContents = value.localizedContents.map(content => {
    if (
      !record(content) ||
      typeof content.locale !== "string" ||
      !["zh_CN", "en_US"].includes(content.locale) ||
      locales.has(content.locale) ||
      typeof content.title !== "string" ||
      !content.title.trim() ||
      content.title.length > 120
    )
      fail();
    const locale = content.locale as AiEditorLocale;
    locales.add(locale);
    const chunks: Record<Field, string[]> = { description: [], input: [], output: [], limitsAndHints: [] };
    const seen: Record<Field, Set<string>> = {
      description: new Set(),
      input: new Set(),
      output: new Set(),
      limitsAndHints: new Set()
    };
    const append = (field: Field, text: unknown, sectionTitle?: string) => {
      if (text == null) return;
      if (typeof text !== "string" || text.length > 500000) fail();
      const normalized = normalizeAiMarkdown(text).trim();
      if (!normalized || seen[field].has(normalized)) return;
      seen[field].add(normalized);
      chunks[field].push(sectionTitle ? `### ${heading(sectionTitle)}\n\n${normalized}` : normalized);
    };
    for (const field of fields) {
      if (own(content, field) && typeof content[field] !== "string") fail();
      append(field, content[field]);
    }
    if (own(content, "contentSections")) {
      if (!Array.isArray(content.contentSections) || content.contentSections.length > 120) fail();
      for (const section of content.contentSections) {
        if (
          !record(section) ||
          typeof section.type !== "string" ||
          !["Text", "Sample"].includes(section.type) ||
          typeof section.sectionTitle !== "string" ||
          section.sectionTitle.length > 120 ||
          (section.text != null && (typeof section.text !== "string" || section.text.length > 500000))
        )
          fail();
        if (section.type === "Sample") {
          // Rebuild references from the shared sample array; preserve explanations as hints.
          if (typeof section.text === "string" && section.text.trim()) {
            if (
              typeof section.sampleId !== "number" ||
              !Number.isInteger(section.sampleId) ||
              section.sampleId < 0 ||
              section.sampleId >= samples.length
            )
              throw new AiError("INVALID_AI_SAMPLE");
            const explanationTitle = locale === "zh_CN" ? "样例解释" : "Sample Explanation";
            append(
              "limitsAndHints",
              section.text,
              samples.length > 1 ? `${explanationTitle} ${section.sampleId + 1}` : explanationTitle
            );
          }
          continue;
        }
        const target = classify(section.sectionTitle, section.text || "");
        if (target) append(target.field, section.text, target.keepHeading ? section.sectionTitle : undefined);
      }
    }
    const fieldText = Object.fromEntries(fields.map(field => [field, chunks[field].join("\n\n")])) as Record<
      Field,
      string
    >;
    if (fields.some(field => fieldText[field].length > 500000)) fail();
    const textSection = (field: Field): AiEditorSection => ({
      type: ProblemContentSectionType.Text,
      sectionTitle: titles[locale][field],
      text: fieldText[field]
    });
    return {
      locale,
      title: content.title,
      contentSections: [
        textSection("description"),
        textSection("input"),
        textSection("output"),
        ...samples.map(
          (_sample, sampleId): AiEditorSection => ({
            type: ProblemContentSectionType.Sample,
            sectionTitle: samples.length > 1 ? `${titles[locale].sample} ${sampleId + 1}` : titles[locale].sample,
            text: "",
            sampleId
          })
        ),
        textSection("limitsAndHints")
      ]
    };
  });
  return { localizedContents, samples };
}
