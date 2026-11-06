import SVGtoPDF from "svg-to-pdfkit";

import type PDFDocument from "pdfkit";
import LineBreaker from "linebreak";

import { Align, Block, Inline, ListItem, TableCell, TextStyle } from "./blocks";
import { DocumentFonts, FontRole } from "./fonts";
import { ImageFailure, LoadedImage } from "./images";
import { MathBox, MathRenderer } from "./math";

type PdfDocument = typeof PDFDocument.prototype;

/**
 * Lays blocks out for the page: each block becomes slices, rows of fixed height that are drawn later wherever the
 * paginator puts them. A paragraph's lines, a code block's lines and a table's rows are separate slices, so pages break
 * between them. Lines break where Unicode allows (UAX #14: between words, between Chinese characters, never before
 * closing punctuation); formulas are typeset by MathJax and drawn as vectors.
 */

export interface Slice {
  height: number;
  /** `y` is the slice's top */
  draw(x: number, y: number): void;
  /** Distance from the top to the first line's baseline (for list markers) */
  baseline?: number;
  /** Starts a new page */
  breakBefore?: boolean;
  /** Stays on a page with the slice after it (headings) */
  keepWithNext?: boolean;
  /** Space that isn't kept at the top of a page */
  spacer?: boolean;
  /** An entry in the PDF's outline, at this point */
  anchor?: string;
}

export interface LayoutWarning {
  kind: "image" | "formula";
  source: string;
  message: string;
}

export interface LayoutOptions {
  /** Body text size in points */
  size: number;
  images: Map<string, LoadedImage | ImageFailure>;
  imageMissing: string;
  warn(warning: LayoutWarning): void;
}

const COLORS = {
  text: "#1b1c1d",
  muted: "#767676",
  border: "#d4d4d5",
  codeBackground: "#f6f8fa",
  headerBackground: "#f3f4f5",
  quote: "#c8c8c8"
};

// MathJax's TeX fonts have a smaller x-height than Noto Sans; pages scale formulas the same way (matchFontHeight)
const MATH_SCALE = 1.12;
const PX = 0.75;
const LINE_HEIGHT = 1.55;
const MONO_SIZE = 0.86;

interface TextPiece {
  kind: "text";
  text: string;
  style: TextStyle;
  size: number;
  role: FontRole;
  shift: number;
  color: string;
}

interface MathPiece {
  kind: "math";
  box: MathBox;
  size: number;
  scale: number;
}

interface ImagePiece {
  kind: "image";
  image: LoadedImage;
  width: number;
  height: number;
  alt: string;
}

type Piece = TextPiece | MathPiece | ImagePiece | { kind: "break" };

interface Fragment {
  piece: Piece;
  /** For text: the part of the piece's text on the line */
  text?: string;
  width: number;
  ascent: number;
  descent: number;
}

interface Segment {
  fragments: Fragment[];
  width: number;
  /** Width of the spaces at its end, not counted at the end of a line */
  trailing: number;
  required: boolean;
}

interface Line {
  fragments: Fragment[];
  width: number;
  ascent: number;
  descent: number;
}

function headingScale(level: number) {
  return [1, 1.5, 1.3, 1.15, 1.05, 1, 1][level] ?? 1;
}

export class Layout {
  constructor(
    private readonly doc: PdfDocument,
    private readonly fonts: DocumentFonts,
    private readonly math: MathRenderer,
    private readonly options: LayoutOptions
  ) {}

  get size() {
    return this.options.size;
  }

  // ---- Inline content ----

  private pieces(inlines: Inline[], size: number, base: TextStyle): Piece[] {
    const pieces: Piece[] = [];
    for (const inline of inlines) {
      if (inline.kind === "break") {
        pieces.push({ kind: "break" });
        continue;
      }
      const style = { ...base, ...inline.style };
      const scale = (style.scale ?? 1) * (style.script ? 0.75 : 1);
      const pieceSize = size * scale;
      if (inline.kind === "text") {
        const mono = !!style.mono;
        pieces.push({
          kind: "text",
          text: inline.text,
          style,
          size: mono ? pieceSize * MONO_SIZE : pieceSize,
          role: mono ? "mono" : "text",
          shift: style.script === "sup" ? -size * 0.38 : style.script === "sub" ? size * 0.18 : 0,
          color: style.color ?? COLORS.text
        });
      } else if (inline.kind === "math") {
        const box = this.math.render(inline.tex, false);
        if (box) pieces.push({ kind: "math", box, size: pieceSize, scale: MATH_SCALE });
        else {
          this.options.warn({ kind: "formula", source: inline.tex, message: "The formula couldn't be typeset" });
          pieces.push({
            kind: "text",
            text: `$${inline.tex}$`,
            style: { ...style, mono: true },
            size: pieceSize * MONO_SIZE,
            role: "mono",
            shift: 0,
            color: COLORS.muted
          });
        }
      } else {
        const image = this.options.images.get(inline.src);
        if (image && "kind" in image) {
          let width =
            (inline.width ?? (inline.height ? (inline.height * image.width) / image.height : image.width)) * PX;
          const height =
            (inline.height ?? (inline.width ? (inline.width * image.height) / image.width : image.height)) * PX;
          // A percentage of the line is resolved when the line's width is known (a negative width)
          if (inline.widthPercent) width = -inline.widthPercent;
          pieces.push({ kind: "image", image, width, height, alt: inline.alt });
        } else {
          this.missingImage(inline.src, image);
          pieces.push({
            kind: "text",
            text: `[${this.options.imageMissing}${inline.alt ? `: ${inline.alt}` : ""}]`,
            style,
            size: pieceSize * 0.9,
            role: "text",
            shift: 0,
            color: COLORS.muted
          });
        }
      }
    }
    return pieces;
  }

  private missingImage(source: string, failure: LoadedImage | ImageFailure | undefined) {
    this.options.warn({
      kind: "image",
      source: source.startsWith("data:") ? `${source.slice(0, 64)}…` : source,
      message: failure && "error" in failure ? failure.error : "The image couldn't be included"
    });
  }

  private textWidth(piece: TextPiece, text: string) {
    return this.fonts.width(text, piece.size, piece.role, !!piece.style.bold, !!piece.style.italic);
  }

  private fragment(piece: Piece, text: string | undefined, lineWidth: number): Fragment {
    switch (piece.kind) {
      case "text": {
        const width = this.textWidth(piece, text);
        return {
          piece,
          text,
          width,
          ascent: piece.size * 1.05 - piece.shift,
          descent: piece.size * 0.35 + piece.shift
        };
      }
      case "math": {
        let { scale } = piece;
        const width = piece.box.width * piece.size * scale;
        if (width > lineWidth) scale *= lineWidth / width;
        return {
          piece: { ...piece, scale },
          width: piece.box.width * piece.size * scale,
          ascent: piece.box.height * piece.size * scale,
          descent: piece.box.depth * piece.size * scale
        };
      }
      case "image": {
        let { width, height } = piece;
        if (width < 0) {
          width = (lineWidth * -width) / 100;
          height = width * (piece.image.height / piece.image.width);
        }
        if (width > lineWidth) {
          height *= lineWidth / width;
          width = lineWidth;
        }
        return { piece: { ...piece, width, height }, width, ascent: height, descent: 0 };
      }
      default:
        return { piece, width: 0, ascent: 0, descent: 0 };
    }
  }

  /** The paragraph's pieces cut where lines may break */
  private segments(pieces: Piece[], lineWidth: number): Segment[] {
    // One string for the whole paragraph: a formula counts as a letter (so no line starts with the punctuation after
    // it), an image as an object (lines may break around it), a line break as a newline
    let joined = "";
    const ranges: { piece: Piece; start: number; end: number }[] = [];
    for (const piece of pieces) {
      const start = joined.length;
      joined +=
        piece.kind === "text" ? piece.text : piece.kind === "math" ? "x" : piece.kind === "image" ? "\ufffc" : "\n";
      ranges.push({ piece, start, end: joined.length });
    }
    const segments: Segment[] = [];
    const breaker = new LineBreaker(joined);
    let previous = 0;
    for (let found = breaker.nextBreak(); found; found = breaker.nextBreak()) {
      const end = found.position;
      const fragments: Fragment[] = [];
      for (const range of ranges) {
        if (range.end <= previous || range.start >= end) continue;
        if (range.piece.kind === "text") {
          const text = range.piece.text.slice(
            Math.max(previous, range.start) - range.start,
            Math.min(end, range.end) - range.start
          );
          if (text) fragments.push(this.fragment(range.piece, text, lineWidth));
        } else fragments.push(this.fragment(range.piece, undefined, lineWidth));
      }
      previous = end;
      if (!fragments.length) continue;
      const last = fragments[fragments.length - 1];
      let trailing = 0;
      if (last.piece.kind === "text") {
        const spaces = /[ \u3000]+$/.exec(last.text)?.[0];
        if (spaces) trailing = this.textWidth(last.piece, spaces);
      }
      segments.push({
        fragments,
        width: fragments.reduce((sum, fragment) => sum + fragment.width, 0),
        trailing,
        required: found.required || fragments.some(fragment => fragment.piece.kind === "break")
      });
    }
    return segments;
  }

  /** A segment wider than a line, cut between characters */
  private split(segment: Segment, lineWidth: number): Segment[] {
    const result: Segment[] = [];
    let current: Fragment[] = [];
    let width = 0;
    const push = () => {
      if (current.length) result.push({ fragments: current, width, trailing: 0, required: false });
      current = [];
      width = 0;
    };
    for (const fragment of segment.fragments) {
      if (fragment.piece.kind !== "text") {
        if (width + fragment.width > lineWidth) push();
        current.push(fragment);
        width += fragment.width;
        continue;
      }
      let text = "";
      for (const character of fragment.text) {
        const next = this.textWidth(fragment.piece, text + character);
        if (width + next > lineWidth && (text || current.length)) {
          if (text) current.push(this.fragment(fragment.piece, text, lineWidth));
          push();
          text = character;
        } else text += character;
      }
      if (text) {
        const piece = this.fragment(fragment.piece, text, lineWidth);
        current.push(piece);
        width += piece.width;
      }
    }
    push();
    if (result.length) result[result.length - 1].required = segment.required;
    return result;
  }

  lines(inlines: Inline[], lineWidth: number, size: number, base: TextStyle = {}): Line[] {
    const segments = this.segments(this.pieces(inlines, size, base), lineWidth);
    const lines: Line[] = [];
    let line: Line = null;
    let trailing = 0;
    const finish = () => {
      if (!line) return;
      line.width -= trailing;
      lines.push(line);
      line = null;
    };
    const queue = [...segments];
    while (queue.length) {
      const segment = queue.shift();
      if (
        segment.width - segment.trailing > lineWidth &&
        segment.fragments.some(fragment => fragment.piece.kind === "text")
      ) {
        const parts = this.split(segment, lineWidth);
        if (parts.length > 1 || parts[0]?.width < segment.width) {
          queue.unshift(...parts);
          continue;
        }
      }
      if (line && line.width - trailing + segment.width - segment.trailing > lineWidth) finish();
      line ??= { fragments: [], width: 0, ascent: size * 1.05, descent: size * (LINE_HEIGHT - 1.05) };
      for (const fragment of segment.fragments) {
        if (fragment.piece.kind === "break") continue;
        line.fragments.push(fragment);
        line.ascent = Math.max(line.ascent, fragment.ascent + (fragment.piece.kind === "text" ? 0 : size * 0.15));
        line.descent = Math.max(line.descent, fragment.descent + (fragment.piece.kind === "text" ? 0 : size * 0.2));
      }
      line.width += segment.width;
      trailing = segment.trailing;
      if (segment.required) finish();
    }
    finish();
    return lines;
  }

  /** Minimum (the widest unbreakable part) and preferred (one line per paragraph) widths, for tables */
  private measureInlines(inlines: Inline[], size: number, base: TextStyle) {
    const segments = this.segments(this.pieces(inlines, size, base), 100000);
    let minimum = 0;
    let maximum = 0;
    let line = 0;
    for (const segment of segments) {
      minimum = Math.max(minimum, Math.min(segment.width - segment.trailing, size * 12));
      line += segment.width;
      if (segment.required) {
        maximum = Math.max(maximum, line - segment.trailing);
        line = 0;
      }
    }
    return { minimum, maximum: Math.max(maximum, line) };
  }

  private drawLine(line: Line, x: number, baseline: number) {
    let cursor = x;
    for (const fragment of line.fragments) {
      const { piece } = fragment;
      if (piece.kind === "text") this.drawText(piece, fragment.text, cursor, baseline);
      else if (piece.kind === "math") this.drawMath(piece.box, cursor, baseline, piece.size * piece.scale);
      else if (piece.kind === "image")
        this.drawImage(piece.image, cursor, baseline - piece.height, piece.width, piece.height, piece.alt);
      cursor += fragment.width;
    }
  }

  private drawText(piece: TextPiece, text: string, x: number, baseline: number) {
    const { style } = piece;
    if (style.code && text.trim()) {
      const width = this.textWidth(piece, text);
      this.doc
        .save()
        .roundedRect(x - 1, baseline - piece.size * 0.95, width + 2, piece.size * 1.3, 1.5)
        .fill(COLORS.codeBackground)
        .restore();
    }
    let cursor = x;
    for (const run of this.fonts.runs(text, piece.role, !!style.bold, !!style.italic)) {
      this.doc.font(run.font).fontSize(piece.size).fillColor(piece.color);
      const width = this.doc.widthOfString(run.text);
      this.doc.text(run.text, cursor, baseline + piece.shift, {
        lineBreak: false,
        baseline: "alphabetic",
        underline: !!style.underline,
        strike: !!style.strike,
        link: style.link ?? null
      } as Parameters<PdfDocument["text"]>[1]);
      cursor += width;
    }
  }

  /** Draws SVG safely: no files, no external documents, fonts from this document */
  drawSvg(svg: string, x: number, y: number, width: number, height: number) {
    const prepared = svg.replace(/<text([^>]*)>([^<]*)<\/text>/g, (_whole, attributes: string, content: string) => {
      const decoded = content
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&amp;/g, "&");
      // Each script in its own font: a <tspan> per run
      const runs = this.fonts.runs(decoded, "text", /font-weight="bold"/.test(attributes), false);
      const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const spans = runs.map(run => `<tspan font-family="${run.font}">${escape(run.text)}</tspan>`).join("");
      return `<text${attributes.replace(/\sfont-family="[^"]*"/, "")}>${spans}</text>`;
    });
    SVGtoPDF(this.doc, prepared, x, y, {
      width,
      height,
      preserveAspectRatio: "xMinYMin meet",
      fontCallback: (family: string) => family,
      imageCallback: (link: string) => (/^data:image\/(png|jpeg);base64,/i.test(link) ? link : Buffer.alloc(0)),
      documentCallback: () => [],
      warningCallback: () => undefined
    });
  }

  private drawMath(box: MathBox, x: number, baseline: number, em: number) {
    this.doc.save().fillColor(COLORS.text).strokeColor(COLORS.text);
    this.drawSvg(box.svg, x, baseline - box.height * em, box.width * em, (box.height + box.depth) * em);
    this.doc.restore();
  }

  private drawImage(image: LoadedImage, x: number, y: number, width: number, height: number, alt: string) {
    try {
      if (image.kind === "svg") this.drawSvg(image.data.toString("utf8"), x, y, width, height);
      else this.doc.image(image.data, x, y, { width, height });
    } catch {
      this.doc.save().rect(x, y, width, height).lineWidth(0.5).stroke(COLORS.border).restore();
      this.options.warn({ kind: "image", source: alt || "image", message: "The image's data couldn't be read" });
    }
  }

  // ---- Blocks ----

  private lineSlices(lines: Line[], width: number, align: Align | undefined): Slice[] {
    return lines.map(line => {
      const offset = align === "center" ? (width - line.width) / 2 : align === "right" ? width - line.width : 0;
      return {
        height: line.ascent + line.descent,
        baseline: line.ascent,
        draw: (x, y) => this.drawLine(line, x + Math.max(0, offset), y + line.ascent)
      };
    });
  }

  paragraph(
    inlines: Inline[],
    width: number,
    options: { size?: number; style?: TextStyle; align?: Align; after?: number; keepWithNext?: boolean } = {}
  ): Slice[] {
    const size = options.size ?? this.size;
    const slices = this.lineSlices(this.lines(inlines, width, size, options.style ?? {}), width, options.align);
    if (options.keepWithNext && slices.length) slices[slices.length - 1].keepWithNext = true;
    if (options.after) slices.push({ height: options.after, spacer: true, draw: () => undefined });
    return slices;
  }

  /** A code block, or one side of a sample: monospace lines on a grey background, long lines wrapped */
  code(text: string, width: number, header?: { label: string; note?: string }): Slice[] {
    const size = this.size * MONO_SIZE;
    const lineHeight = size * 1.45;
    const padding = 5;
    const inner = width - 2 * padding;
    const piece: TextPiece = { kind: "text", text: "", style: {}, size, role: "mono", shift: 0, color: COLORS.text };
    const visual: string[] = [];
    for (const line of text.split("\n")) {
      if (!line) {
        visual.push("");
        continue;
      }
      // Long lines wrap after a space when there is one on the line, else between characters
      let current = "";
      for (const character of line) {
        if (current && this.textWidth(piece, current + character) > inner) {
          const space = current.lastIndexOf(" ");
          if (space > 0 && space < current.length - 1 && character !== " ") {
            visual.push(current.slice(0, space + 1));
            current = current.slice(space + 1) + character;
          } else {
            visual.push(current);
            current = character === " " ? "" : character;
          }
        } else current += character;
      }
      visual.push(current);
    }
    const slices: Slice[] = [];
    if (header) {
      const labelHeight = this.size * 1.6;
      slices.push({
        height: labelHeight,
        keepWithNext: true,
        draw: (x, y) => {
          const baseline = y + labelHeight - this.size * 0.45;
          this.drawText(
            { ...piece, style: { bold: true }, size: this.size * 0.9, role: "text" },
            header.label,
            x,
            baseline
          );
          if (header.note) {
            const notePiece: TextPiece = { ...piece, size: this.size * 0.8, color: COLORS.muted };
            this.drawText(notePiece, header.note, x + width - this.textWidth(notePiece, header.note), baseline);
          }
        }
      });
    }
    // A short block stays on one page
    const together = visual.length <= 8;
    visual.forEach((line, index) => {
      const first = index === 0;
      const last = index === visual.length - 1;
      const height = lineHeight + (first ? padding : 0) + (last ? padding : 0);
      slices.push({
        height,
        keepWithNext: together && !last,
        draw: (x, y) => {
          this.doc.save().rect(x, y, width, height).fill(COLORS.codeBackground);
          this.doc.lineWidth(0.5).strokeColor(COLORS.border);
          this.doc
            .moveTo(x, y)
            .lineTo(x, y + height)
            .moveTo(x + width, y)
            .lineTo(x + width, y + height)
            .stroke();
          if (first)
            this.doc
              .moveTo(x, y)
              .lineTo(x + width, y)
              .stroke();
          if (last)
            this.doc
              .moveTo(x, y + height)
              .lineTo(x + width, y + height)
              .stroke();
          this.doc.restore();
          if (line) this.drawText(piece, line, x + padding, y + (first ? padding : 0) + size * 1.1);
        }
      });
    });
    return slices;
  }

  private image(block: Extract<Block, { kind: "image" }>, width: number, maximumHeight: number): Slice[] {
    const image = this.options.images.get(block.src);
    if (!image || !("kind" in image)) {
      this.missingImage(block.src, image);
      const label = `[${this.options.imageMissing}${block.alt ? `: ${block.alt}` : ""}] ${block.src.startsWith("data:") ? "" : block.src}`;
      return this.paragraph([{ kind: "text", text: label, style: { color: COLORS.muted, scale: 0.9 } }], width, {
        after: this.size * 0.6
      });
    }
    let drawWidth = block.widthPercent
      ? (width * block.widthPercent) / 100
      : (block.width ?? (block.height ? (block.height * image.width) / image.height : image.width)) * PX;
    let drawHeight = block.widthPercent
      ? drawWidth * (image.height / image.width)
      : (block.height ?? (block.width ? (block.width * image.height) / image.width : image.height)) * PX;
    const scale = Math.min(1, width / drawWidth, maximumHeight / drawHeight);
    drawWidth *= scale;
    drawHeight *= scale;
    const offset = block.align === "center" ? (width - drawWidth) / 2 : block.align === "right" ? width - drawWidth : 0;
    return [
      {
        height: drawHeight,
        draw: (x, y) => this.drawImage(image, x + offset, y, drawWidth, drawHeight, block.alt)
      },
      { height: this.size * 0.6, spacer: true, draw: () => undefined }
    ];
  }

  private displayMath(block: Extract<Block, { kind: "math" }>, width: number): Slice[] {
    const box = this.math.render(block.tex, true);
    if (!box) {
      this.options.warn({ kind: "formula", source: block.tex, message: "The formula couldn't be typeset" });
      return this.code(`$$${block.tex}$$`, width);
    }
    const em = Math.min(this.size * MATH_SCALE, width / Math.max(box.width, 0.01));
    const drawWidth = box.width * em;
    const height = (box.height + box.depth) * em;
    const gap = this.size * 0.45;
    return [
      {
        height: height + 2 * gap,
        draw: (x, y) => this.drawMath(box, x + (width - drawWidth) / 2, y + gap + box.height * em, em)
      }
    ];
  }

  /** Child slices moved right, with something drawn beside each (a quote's bar) */
  private indent(slices: Slice[], by: number, beside?: (x: number, y: number, height: number) => void): Slice[] {
    return slices.map(slice => ({
      ...slice,
      draw: (x, y) => {
        beside?.(x, y, slice.height);
        slice.draw(x + by, y);
      }
    }));
  }

  private list(block: Extract<Block, { kind: "list" }>, width: number, depth: number): Slice[] {
    const markerWidth = block.ordered
      ? this.fonts.width(`${block.start + block.items.length - 1}.`, this.size, "text") + this.size * 0.6
      : this.size * 1.4;
    const indent = Math.max(this.size * 1.6, markerWidth);
    const slices: Slice[] = [];
    block.items.forEach((item: ListItem, index) => {
      const content = this.blocks(item.blocks, width - indent, depth + 1);
      while (content.length && content[content.length - 1].spacer) content.pop();
      if (!content.length)
        content.push({ height: this.size * LINE_HEIGHT, baseline: this.size * 1.05, draw: () => undefined });
      const first = content[0];
      const baseline = first.baseline ?? this.size * 1.05;
      const marker = (x: number, y: number) => {
        const middle = y + baseline - this.size * 0.33;
        if (item.task) {
          const side = this.size * 0.75;
          const left = x + indent - side - this.size * 0.5;
          this.doc
            .save()
            .lineWidth(0.7)
            .strokeColor(COLORS.text)
            .rect(left, middle - side / 2, side, side)
            .stroke();
          if (item.task.checked)
            this.doc
              .moveTo(left + side * 0.2, middle)
              .lineTo(left + side * 0.42, middle + side * 0.25)
              .lineTo(left + side * 0.82, middle - side * 0.3)
              .stroke();
          this.doc.restore();
        } else if (block.ordered) {
          const text = `${block.start + index}.`;
          const piece: TextPiece = {
            kind: "text",
            text,
            style: {},
            size: this.size,
            role: "text",
            shift: 0,
            color: COLORS.text
          };
          this.drawText(piece, text, x + indent - this.size * 0.4 - this.textWidth(piece, text), y + baseline);
        } else {
          const center = x + indent - this.size * 0.8;
          const radius = this.size * 0.17;
          this.doc.save().fillColor(COLORS.text).strokeColor(COLORS.text).lineWidth(0.6);
          if (depth % 3 === 0) this.doc.circle(center, middle, radius).fill();
          else if (depth % 3 === 1) this.doc.circle(center, middle, radius).stroke();
          else this.doc.rect(center - radius, middle - radius, radius * 2, radius * 2).fill();
          this.doc.restore();
        }
      };
      content[0] = {
        ...first,
        draw: (x, y) => {
          marker(x, y);
          first.draw(x + indent, y);
        }
      };
      slices.push(content[0], ...this.indent(content.slice(1), indent), {
        height: this.size * 0.2,
        spacer: true,
        draw: () => undefined
      });
    });
    slices.push({ height: this.size * 0.4, spacer: true, draw: () => undefined });
    return slices;
  }

  // ---- Tables ----

  private measureBlocks(blocks: Block[], depth = 0): { minimum: number; maximum: number } {
    let minimum = 0;
    let maximum = 0;
    for (const block of blocks) {
      let size = { minimum: 0, maximum: 0 };
      switch (block.kind) {
        case "paragraph":
          size = this.measureInlines(
            block.inlines,
            this.size * headingScale(block.heading),
            block.heading ? { bold: true } : {}
          );
          break;
        case "code": {
          const piece: TextPiece = {
            kind: "text",
            text: "",
            style: {},
            size: this.size * MONO_SIZE,
            role: "mono",
            shift: 0,
            color: ""
          };
          const widest = Math.max(0, ...block.text.split("\n").map(line => this.textWidth(piece, line)));
          size = { minimum: Math.min(widest, this.size * 10) + 10, maximum: widest + 10 };
          break;
        }
        case "math": {
          const box = this.math.render(block.tex, true);
          const width = box ? box.width * this.size * MATH_SCALE : this.size * 10;
          size = { minimum: width, maximum: width };
          break;
        }
        case "image": {
          const image = this.options.images.get(block.src);
          const width = image && "kind" in image ? (block.width ?? image.width) * PX : this.size * 8;
          size = { minimum: Math.min(width, this.size * 8), maximum: width };
          break;
        }
        case "list":
        case "quote":
        case "indent": {
          const inner =
            block.kind === "list"
              ? this.measureBlocks(
                  block.items.flatMap(item => item.blocks),
                  depth + 1
                )
              : this.measureBlocks(block.blocks, depth + 1);
          size = { minimum: inner.minimum + this.size * 1.6, maximum: inner.maximum + this.size * 1.6 };
          break;
        }
        case "table": {
          const columns = this.columnSizes(block.rows);
          size = {
            minimum: columns.reduce((sum, column) => sum + column.minimum, 0),
            maximum: columns.reduce((sum, column) => sum + column.maximum, 0)
          };
          break;
        }
        default:
          break;
      }
      minimum = Math.max(minimum, size.minimum);
      maximum = Math.max(maximum, size.maximum);
    }
    return { minimum, maximum };
  }

  /** Where each cell sits in the table's grid, with rows and columns that cells span */
  private grid(rows: TableCell[][]) {
    const placed: { cell: TableCell; row: number; column: number }[] = [];
    const taken: boolean[][] = [];
    let columns = 0;
    rows.forEach((cells, row) => {
      taken[row] ??= [];
      let column = 0;
      for (const cell of cells) {
        while (taken[row][column]) column++;
        placed.push({ cell, row, column });
        for (let r = row; r < Math.min(rows.length, row + cell.rowspan); r++)
          for (let c = column; c < column + cell.colspan; c++) (taken[r] ??= [])[c] = true;
        column += cell.colspan;
        columns = Math.max(columns, column);
      }
    });
    return { placed, columns };
  }

  private columnSizes(rows: TableCell[][]) {
    const padding = 10;
    const { placed, columns } = this.grid(rows);
    const sizes = Array.from({ length: columns }, () => ({ minimum: padding, maximum: padding }));
    for (const { cell, column } of placed.filter(entry => entry.cell.colspan === 1)) {
      const size = this.measureBlocks(cell.blocks);
      sizes[column].minimum = Math.max(sizes[column].minimum, size.minimum + padding);
      sizes[column].maximum = Math.max(sizes[column].maximum, size.maximum + padding);
    }
    for (const { cell, column } of placed.filter(entry => entry.cell.colspan > 1)) {
      const size = this.measureBlocks(cell.blocks);
      const spanned = sizes.slice(column, column + cell.colspan);
      const minimum = spanned.reduce((sum, s) => sum + s.minimum, 0);
      const maximum = spanned.reduce((sum, s) => sum + s.maximum, 0);
      for (const s of spanned) {
        if (size.minimum + padding > minimum) s.minimum += (size.minimum + padding - minimum) / spanned.length;
        if (size.maximum + padding > maximum) s.maximum += (size.maximum + padding - maximum) / spanned.length;
      }
    }
    return sizes;
  }

  private table(block: Extract<Block, { kind: "table" }>, width: number): Slice[] {
    const sizes = this.columnSizes(block.rows);
    if (!sizes.length) return [];
    const total = (key: "minimum" | "maximum") => sizes.reduce((sum, size) => sum + size[key], 0);
    let widths: number[];
    if (total("maximum") <= width) widths = sizes.map(size => size.maximum);
    else if (total("minimum") >= width) widths = sizes.map(size => (size.minimum * width) / total("minimum"));
    else {
      const room = (width - total("minimum")) / (total("maximum") - total("minimum"));
      widths = sizes.map(size => size.minimum + (size.maximum - size.minimum) * room);
    }
    const { placed } = this.grid(block.rows);
    const padding = 5;
    const laid = placed.map(entry => {
      const cellWidth = widths.slice(entry.column, entry.column + entry.cell.colspan).reduce((sum, w) => sum + w, 0);
      const content = this.blocks(entry.cell.blocks, cellWidth - 2 * padding, 1);
      while (content.length && content[content.length - 1].spacer) content.pop();
      return {
        ...entry,
        width: cellWidth,
        content,
        height: content.reduce((sum, s) => sum + s.height, 0) + 2 * padding
      };
    });
    const heights = block.rows.map(() => this.size * LINE_HEIGHT + 2 * padding);
    for (const cell of laid.filter(entry => entry.cell.rowspan === 1))
      heights[cell.row] = Math.max(heights[cell.row], cell.height);
    for (const cell of laid.filter(entry => entry.cell.rowspan > 1)) {
      const last = Math.min(block.rows.length, cell.row + cell.cell.rowspan) - 1;
      const spanned = heights.slice(cell.row, last + 1).reduce((sum, h) => sum + h, 0);
      if (cell.height > spanned) heights[last] += cell.height - spanned;
    }
    // Rows joined by cells that span them stay together on one page
    const groups: [number, number][] = [];
    let start = 0;
    let end = 0;
    block.rows.forEach((_, row) => {
      for (const cell of laid.filter(entry => entry.row === row)) end = Math.max(end, row + cell.cell.rowspan - 1);
      if (row >= end) {
        groups.push([start, row]);
        start = row + 1;
        end = row + 1;
      }
    });
    const left = (column: number) => widths.slice(0, column).reduce((sum, w) => sum + w, 0);
    const slices: Slice[] = groups.map(([first, last]) => {
      const top = (row: number) => heights.slice(first, row).reduce((sum, h) => sum + h, 0);
      const height = heights.slice(first, last + 1).reduce((sum, h) => sum + h, 0);
      return {
        height,
        draw: (x, y) => {
          for (const cell of laid.filter(entry => entry.row >= first && entry.row <= last)) {
            const cellX = x + left(cell.column);
            const cellY = y + top(cell.row);
            const cellHeight = heights.slice(cell.row, cell.row + cell.cell.rowspan).reduce((sum, h) => sum + h, 0);
            if (cell.cell.header)
              this.doc.save().rect(cellX, cellY, cell.width, cellHeight).fill(COLORS.headerBackground).restore();
            this.doc
              .save()
              .lineWidth(0.5)
              .strokeColor(COLORS.border)
              .rect(cellX, cellY, cell.width, cellHeight)
              .stroke()
              .restore();
            let cursor = cellY + padding;
            for (const slice of cell.content) {
              slice.draw(cellX + padding, cursor);
              cursor += slice.height;
            }
          }
        }
      };
    });
    slices.push({ height: this.size * 0.7, spacer: true, draw: () => undefined });
    return slices;
  }

  // ---- Everything ----

  /** `maximumHeight` limits images (a page's content height) */
  maximumHeight = 700;

  blocks(blocks: Block[], width: number, depth = 0): Slice[] {
    const slices: Slice[] = [];
    for (const block of blocks) {
      switch (block.kind) {
        case "paragraph": {
          const scale = block.size ?? headingScale(block.heading);
          const heading = !!block.heading;
          if (heading && slices.length) slices.push({ height: this.size * 0.5, spacer: true, draw: () => undefined });
          slices.push(
            ...this.paragraph(block.inlines, width, {
              size: this.size * scale,
              style: { ...(heading ? { bold: true } : {}), ...(block.color ? { color: block.color } : {}) },
              align: block.align,
              after: this.size * (heading ? 0.35 : 0.55),
              keepWithNext: heading
            })
          );
          break;
        }
        case "code":
          slices.push(
            ...this.code(block.text, width, block.label ? { label: block.label, note: block.note } : undefined)
          );
          slices.push({ height: this.size * 0.7, spacer: true, draw: () => undefined });
          break;
        case "list":
          slices.push(...this.list(block, width, depth));
          break;
        case "quote": {
          const inner = this.blocks(block.blocks, width - this.size * 1.2, depth + 1);
          while (inner.length && inner[inner.length - 1].spacer) inner.pop();
          slices.push(
            ...this.indent(inner, this.size * 1.2, (x, y, height) =>
              this.doc.save().rect(x, y, 2.5, height).fill(COLORS.quote).restore()
            ),
            { height: this.size * 0.6, spacer: true, draw: () => undefined }
          );
          break;
        }
        case "indent":
          slices.push(...this.indent(this.blocks(block.blocks, width - this.size * 2, depth + 1), this.size * 2));
          break;
        case "table":
          slices.push(...this.table(block, width));
          break;
        case "rule":
          slices.push({
            height: this.size * 1.2,
            draw: (x, y) =>
              this.doc
                .save()
                .lineWidth(0.7)
                .strokeColor(COLORS.border)
                .moveTo(x, y + this.size * 0.6)
                .lineTo(x + width, y + this.size * 0.6)
                .stroke()
                .restore()
          });
          break;
        case "math":
          slices.push(...this.displayMath(block, width));
          break;
        case "image":
          slices.push(...this.image(block, width, this.maximumHeight));
          break;
        case "space":
          slices.push({ height: block.height, spacer: true, draw: () => undefined });
          break;
        case "pageBreak":
          slices.push({ height: 0, breakBefore: true, draw: () => undefined });
          break;
        case "anchor":
          slices.push({ height: 0, anchor: block.title, draw: () => undefined });
          break;
        default:
          break;
      }
    }
    return slices;
  }
}

/** Every image a list of blocks shows */
export function blockImages(blocks: Block[], into = new Set<string>()): Set<string> {
  const inlines = (list: Inline[]) => list.forEach(inline => inline.kind === "image" && into.add(inline.src));
  for (const block of blocks) {
    if (block.kind === "paragraph") inlines(block.inlines);
    else if (block.kind === "image") into.add(block.src);
    else if (block.kind === "list") block.items.forEach(item => blockImages(item.blocks, into));
    else if (block.kind === "quote" || block.kind === "indent") blockImages(block.blocks, into);
    else if (block.kind === "table") block.rows.forEach(row => row.forEach(cell => blockImages(cell.blocks, into)));
  }
  return into;
}
