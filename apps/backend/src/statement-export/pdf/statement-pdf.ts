import PDFDocument from "pdfkit";

import { Block, Inline, TextStyle } from "./blocks";
import { DocumentFonts } from "./fonts";
import { ImageFailure, ImageLoader, LoadedImage } from "./images";
import { Layout, LayoutWarning, Slice, blockImages } from "./layout";
import { markdownBlocks } from "./markdown";
import { MathRenderer } from "./math";

import { Statement, StatementIo, describeIo, statementLabels } from "../statement";
import { statementHeading } from "../statement-markdown";

/**
 * A contest's statements as one PDF: a first page with the contest's title, times and a table of its problems (limits
 * and input/output), then each problem from a new page, in contest order, with its samples named as in the archive.
 * A4, Noto Sans and Noto Sans SC, formulas as vectors, an outline entry per problem and page numbers.
 */

export interface PdfProblem {
  statement: Statement;
  /** The archive's file names for each sample (sample1.in, sample1.ans) */
  sampleFiles: { input: string; output: string }[];
}

export interface PdfBook {
  /** The labels' language */
  locale: string;
  title: string;
  subtitle?: string;
  /** Lines under the title: when the contest runs, its rules */
  details: string[];
  /** The contest's description (Markdown) */
  description?: string;
  problems: PdfProblem[];
}

export interface PdfResult {
  pdf: Buffer;
  pages: number;
  warnings: LayoutWarning[];
}

const PAGE = { width: 595.28, height: 841.89, margin: 56, top: 56, bottom: 62 };
const SIZE = 10.5;

function shortIo(io: StatementIo, labels: ReturnType<typeof statementLabels>) {
  return io.kind === "file"
    ? `${io.input} / ${io.output}`
    : describeIo(io, labels)
        .replace(/[（(].*$/, "")
        .trim();
}

function text(value: string, style: TextStyle = {}): Inline {
  return { kind: "text", text: value, style };
}

function cell(value: string, header = false) {
  return { blocks: [{ kind: "paragraph", inlines: [text(value)] } as Block], header, colspan: 1, rowspan: 1 };
}

function coverBlocks(book: PdfBook): Block[] {
  const labels = statementLabels(book.locale);
  const blocks: Block[] = [
    { kind: "space", height: 40 },
    { kind: "paragraph", inlines: [text(book.title, { bold: true })], align: "center", size: 2.1 }
  ];
  if (book.subtitle) blocks.push({ kind: "paragraph", inlines: [text(book.subtitle)], align: "center", size: 1.15 });
  for (const line of book.details)
    blocks.push({ kind: "paragraph", inlines: [text(line, { color: "#555555" })], align: "center" });
  blocks.push({ kind: "space", height: 18 });
  if (book.problems.length)
    blocks.push({
      kind: "table",
      rows: [
        [
          cell("#", true),
          cell(labels.problem, true),
          cell(labels.timeLimit, true),
          cell(labels.memoryLimit, true),
          cell(labels.io, true)
        ],
        ...book.problems.map(({ statement }) => [
          cell(statement.label),
          cell(statement.title),
          cell(statement.timeLimit ? `${statement.timeLimit} ms` : "—"),
          cell(statement.memoryLimit ? `${statement.memoryLimit} MiB` : "—"),
          cell(shortIo(statement.io, labels))
        ])
      ]
    });
  if (book.description?.trim()) blocks.push({ kind: "space", height: 12 }, ...markdownBlocks(book.description));
  return blocks;
}

function problemBlocks(problem: PdfProblem, locale: string): Block[] {
  const { statement } = problem;
  const labels = statementLabels(locale);
  const heading = statementHeading(statement);
  const facts: Inline[] = [];
  const fact = (label: string, value: string) => {
    if (facts.length) facts.push(text("        "));
    facts.push(text(`${label}${labels.colon}`, { bold: true }), text(value));
  };
  if (statement.timeLimit) fact(labels.timeLimit, `${statement.timeLimit} ms`);
  if (statement.memoryLimit) fact(labels.memoryLimit, `${statement.memoryLimit} MiB`);
  const io: Inline[] =
    statement.io.kind === "file"
      ? [
          text(`${labels.io}${labels.colon}`, { bold: true }),
          text(`${labels.fileIo}${labels.open}${labels.inputFile}${labels.colon}`),
          text(statement.io.input, { mono: true, code: true }),
          text(`${labels.comma}${labels.outputFile}${labels.colon}`),
          text(statement.io.output, { mono: true, code: true }),
          text(labels.close)
        ]
      : [text(`${labels.io}${labels.colon}`, { bold: true }), text(describeIo(statement.io, labels))];
  const blocks: Block[] = [
    { kind: "pageBreak" },
    { kind: "anchor", title: heading },
    { kind: "paragraph", inlines: [text(heading, { bold: true })], size: 1.75 },
    ...(facts.length ? [{ kind: "paragraph", inlines: facts } as Block] : []),
    { kind: "paragraph", inlines: io },
    { kind: "rule" }
  ];
  for (const section of statement.sections) {
    blocks.push({ kind: "paragraph", inlines: [text(section.title, { bold: true })], heading: 2, size: 1.25 });
    if (section.kind === "sample") {
      const files = problem.sampleFiles[section.sample.number - 1];
      blocks.push(
        { kind: "code", text: section.sample.input.replace(/\n$/, ""), label: labels.input, note: files?.input },
        { kind: "code", text: section.sample.output.replace(/\n$/, ""), label: labels.output, note: files?.output }
      );
    }
    if (section.text?.trim()) blocks.push(...markdownBlocks(section.text));
  }
  if (statement.files.length)
    blocks.push(
      { kind: "paragraph", inlines: [text(labels.files, { bold: true })], heading: 2, size: 1.25 },
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: statement.files.map(file => ({
          blocks: [{ kind: "paragraph", inlines: [text(file, { mono: true })] } as Block]
        }))
      }
    );
  return blocks;
}

/** Puts slices on pages: a new page when the next slice doesn't fit, headings kept with what follows them */
function paginate(doc: typeof PDFDocument.prototype, slices: Slice[]) {
  const bottom = PAGE.height - PAGE.bottom;
  let y = PAGE.top;
  let pageHasContent = false;
  let started = false;
  const newPage = () => {
    if (started || pageHasContent) doc.addPage();
    y = PAGE.top;
    pageHasContent = false;
  };
  for (let index = 0; index < slices.length; index++) {
    const slice = slices[index];
    if (slice.breakBefore) {
      if (pageHasContent) newPage();
      continue;
    }
    if (slice.anchor) {
      doc.outline.addItem(slice.anchor);
      continue;
    }
    if (slice.spacer && !pageHasContent) continue;
    let needed = slice.height;
    // A heading and the slice after it (with the spacers between them) start a page together
    for (let next = index; slices[next]?.keepWithNext && next + 1 < slices.length; next++)
      needed += slices[next + 1].height;
    if (y + Math.min(needed, bottom - PAGE.top) > bottom && pageHasContent) newPage();
    slice.draw(PAGE.margin, y);
    y += slice.height;
    pageHasContent = true;
    started = true;
  }
}

export async function renderStatementsPdf(book: PdfBook, loader = new ImageLoader()): Promise<PdfResult> {
  const labels = statementLabels(book.locale);
  const parts: { blocks: Block[]; cjk: boolean }[] = [
    { blocks: coverBlocks(book), cjk: book.locale === "zh_CN" },
    ...book.problems.map(problem => ({
      blocks: problemBlocks(problem, book.locale),
      cjk: problem.statement.contentLocale === "zh_CN"
    }))
  ];

  const sources = new Set<string>();
  for (const part of parts) blockImages(part.blocks, sources);
  const images = new Map<string, LoadedImage | ImageFailure>();
  await Promise.all([...sources].map(async source => images.set(source, await loader.load(source))));

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: PAGE.top, bottom: 0, left: PAGE.margin, right: PAGE.margin },
    bufferPages: true,
    autoFirstPage: true,
    displayTitle: true,
    lang: book.locale === "zh_CN" ? "zh-CN" : "en-US",
    info: { Title: book.title, Creator: "LLMOJ" }
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    doc.on("end", resolve);
    doc.on("error", reject);
  });

  const warnings: LayoutWarning[] = [];
  const math = new MathRenderer();
  const layouts = new Map<boolean, Layout>();
  const layoutFor = (cjk: boolean) => {
    if (!layouts.has(cjk)) {
      const layout = new Layout(doc, new DocumentFonts(doc, cjk), math, {
        size: SIZE,
        images,
        imageMissing: labels.imageMissing,
        warn: warning => {
          if (!warnings.some(known => known.kind === warning.kind && known.source === warning.source))
            warnings.push(warning);
        }
      });
      layout.maximumHeight = PAGE.height - PAGE.top - PAGE.bottom - 20;
      layouts.set(cjk, layout);
    }
    return layouts.get(cjk);
  };
  const width = PAGE.width - 2 * PAGE.margin;
  const slices = parts.flatMap(part => layoutFor(part.cjk).blocks(part.blocks, width));

  paginate(doc, slices);
  const range = doc.bufferedPageRange();

  // Footers: the contest's title and the page number
  const footer = layoutFor(book.locale === "zh_CN");
  for (let page = range.start; page < range.start + range.count; page++) {
    doc.switchToPage(page);
    const number = page - range.start + 1;
    const pageText =
      book.locale === "zh_CN"
        ? `第 ${number} / ${range.count} ${labels.page}`
        : `${labels.page} ${number} / ${range.count}`;
    const y = PAGE.height - PAGE.bottom + 22;
    doc
      .save()
      .lineWidth(0.5)
      .strokeColor("#d4d4d5")
      .moveTo(PAGE.margin, y - 12)
      .lineTo(PAGE.width - PAGE.margin, y - 12)
      .stroke()
      .restore();
    const left = footer.paragraph([text(book.title, { color: "#767676", scale: 0.8 })], width * 0.7);
    left[0]?.draw(PAGE.margin, y - 10);
    const right = footer.paragraph([text(pageText, { color: "#767676", scale: 0.8 })], width * 0.3, { align: "right" });
    right[0]?.draw(PAGE.margin + width * 0.7, y - 10);
  }
  doc.end();
  await finished;
  return { pdf: Buffer.concat(chunks), pages: range.count, warnings };
}
