import MarkdownIt from "markdown-it";
import MarkdownItMath from "markdown-it-math-loose";
import MarkdownItMergeCells from "markdown-it-merge-cells/src";
import MarkdownItTaskLists from "@hackmd/markdown-it-task-lists";
import { FilterXSS, escapeAttrValue, getDefaultWhiteList } from "xss";
import { load } from "cheerio/slim";

import { Align, Block, Inline, ListItem, TableCell, TextStyle } from "./blocks";

/**
 * A statement section's Markdown as blocks for the PDF, read the way the site's pages read it (markdown/markdown.ts
 * and sanitize.ts): the same Markdown options and plugins, raw HTML allowed, then the same sanitizer, so the PDF shows
 * what the page shows. "$…$" and "$$…$$" are formulas.
 */

/** The parts of htmlparser2's nodes this reads */
interface DomNode {
  type: string;
  data?: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
}

type AnyNode = DomNode;
type Element = DomNode & { name: string; attribs: Record<string, string>; children: DomNode[] };

/** An element's text, with <br> as a line break (for <pre>) */
function textContent(node: DomNode): string {
  if (node.type === "text") return node.data ?? "";
  if (node.type === "tag" && node.name.toLowerCase() === "br") return "\n";
  return (node.children ?? []).map(textContent).join("");
}

interface Formula {
  tex: string;
  display: boolean;
}

const whiteList = getDefaultWhiteList();
delete whiteList.audio;
delete whiteList.video;
whiteList.input = ["type", "disabled", "checked"];
for (const tag of Object.keys(whiteList)) whiteList[tag].push("style", "class");
whiteList.span.push("data-id");

const sanitizer = new FilterXSS({
  whiteList,
  stripIgnoreTag: true,
  onTagAttr: (tag, name, value) => {
    // Data URIs for <img>, as on the page
    if (tag.toLowerCase() === "img" && name.toLowerCase() === "src" && value.startsWith("data:image/"))
      return `${name}="${escapeAttrValue(value)}"`;
    return undefined;
  }
});

function renderer(formulas: Formula[]) {
  const placeholder = (tex: string, display: boolean) => {
    formulas.push({ tex, display });
    return `<span data-id="formula-${formulas.length - 1}"></span>`;
  };
  const markdown = new MarkdownIt({ html: true, breaks: false, linkify: true, typographer: false });
  markdown.use(MarkdownItMath, {
    inlineOpen: "$",
    inlineClose: "$",
    blockOpen: "$$",
    blockClose: "$$",
    inlineRenderer: (tex: string) => placeholder(tex, false),
    blockRenderer: (tex: string) => placeholder(tex, true)
  });
  markdown.use(MarkdownItMergeCells);
  markdown.use(MarkdownItTaskLists, { enabled: true });
  return markdown;
}

const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#db2828",
  orange: "#f2711c",
  yellow: "#b58105",
  olive: "#8abc1e",
  green: "#21ba45",
  teal: "#00b5ad",
  blue: "#2185d0",
  violet: "#6435c9",
  purple: "#a333c8",
  pink: "#e03997",
  brown: "#a5673f",
  grey: "#767676",
  gray: "#767676",
  navy: "#000080",
  maroon: "#800000",
  silver: "#a0a0a0",
  darkred: "#8b0000",
  darkblue: "#00008b",
  darkgreen: "#006400"
};

/** A CSS color as "#rrggbb", or undefined. Very light colors are darkened to stay readable on white paper. */
export function cssColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.trim().toLowerCase();
  if (NAMED_COLORS[text]) return NAMED_COLORS[text];
  const short = /^#([0-9a-f]{3})$/.exec(text);
  const long = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(text);
  const functional = /^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/.exec(text);
  let rgb: number[];
  if (short) rgb = [...short[1]].map(digit => parseInt(digit + digit, 16));
  else if (long) rgb = [0, 2, 4].map(index => parseInt(long[1].slice(index, index + 2), 16));
  else if (functional) rgb = functional.slice(1, 4).map(number => Math.min(255, Number(number)));
  else return undefined;
  if (rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 200) rgb = rgb.map(channel => Math.round(channel * 0.6));
  return `#${rgb.map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}

function styleProperty(node: Element, property: string) {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i").exec(node.attribs?.style ?? "");
  return match?.[1].trim();
}

function alignOf(node: Element): Align | undefined {
  const value = (styleProperty(node, "text-align") ?? node.attribs?.align ?? "").toLowerCase();
  return value === "center" || value === "right" || value === "left" ? value : undefined;
}

function pixels(value: string | undefined): number | undefined {
  const match = /^\s*([\d.]+)\s*(px)?\s*$/i.exec(value ?? "");
  const number = match && Number(match[1]);
  return number > 0 && number < 100000 ? number : undefined;
}

function percent(value: string | undefined): number | undefined {
  const match = /^\s*([\d.]+)\s*%\s*$/.exec(value ?? "");
  const number = match && Number(match[1]);
  return number > 0 && number <= 100 ? number : undefined;
}

function safeLink(href: string | undefined): string | undefined {
  return href && /^(https?:\/\/|mailto:)/i.test(href.trim()) ? href.trim() : undefined;
}

interface Context {
  style: TextStyle;
  align?: Align;
  heading?: number;
  /** Inside <pre>: whitespace is kept */
  pre?: boolean;
}

const BLOCK_CONTAINERS = new Set([
  "p",
  "div",
  "center",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "nav",
  "aside",
  "address",
  "figure",
  "figcaption",
  "details",
  "summary",
  "dl",
  "dt",
  "caption",
  "li"
]);

class Walker {
  readonly blocks: Block[] = [];

  private inlines: Inline[] = [];

  constructor(private readonly formulas: Formula[]) {}

  /** Ends the current paragraph. A paragraph of images only becomes image blocks. */
  flush(context: Context) {
    const { inlines } = this;
    this.inlines = [];
    // Whitespace at the ends of a paragraph, and around its line breaks, isn't shown
    while (inlines.length && inlines[0].kind === "text" && !inlines[0].text.trim()) inlines.shift();
    while (inlines.length && inlines[inlines.length - 1].kind === "break") inlines.pop();
    while (inlines.length) {
      const last = inlines[inlines.length - 1];
      if (last.kind !== "text" || last.text.trim()) break;
      inlines.pop();
    }
    if (!inlines.length) return;
    if (inlines[0].kind === "text") inlines[0] = { ...inlines[0], text: inlines[0].text.replace(/^\s+/, "") };
    const last = inlines[inlines.length - 1];
    if (last.kind === "text") inlines[inlines.length - 1] = { ...last, text: last.text.replace(/\s+$/, "") };
    const images = inlines.filter(inline => inline.kind === "image");
    if (
      images.length &&
      inlines.every(
        inline => inline.kind === "image" || inline.kind === "break" || (inline.kind === "text" && !inline.text.trim())
      )
    ) {
      for (const image of images)
        if (image.kind === "image")
          this.blocks.push({
            kind: "image",
            src: image.src,
            alt: image.alt,
            width: image.width,
            height: image.height,
            widthPercent: image.widthPercent,
            align: context.align ?? "left"
          });
      return;
    }
    this.blocks.push({ kind: "paragraph", inlines, align: context.align, heading: context.heading });
  }

  private nested(nodes: AnyNode[], context: Context): Block[] {
    const walker = new Walker(this.formulas);
    for (const node of nodes) walker.walk(node, context);
    walker.flush(context);
    return walker.blocks;
  }

  private text(text: string, context: Context) {
    const value = context.pre ? text : text.replace(/[ \t\n\r\f]+/g, " ");
    if (!value) return;
    const last = this.inlines[this.inlines.length - 1];
    // A space after a space (or at the start of a line) isn't shown
    const collapsed =
      !context.pre && (!last || last.kind === "break" || (last.kind === "text" && /\s$/.test(last.text)))
        ? value.replace(/^ /, "")
        : value;
    if (collapsed) this.inlines.push({ kind: "text", text: collapsed, style: context.style });
  }

  walk(node: AnyNode, context: Context) {
    if (node.type === "text") {
      this.text(node.data, context);
      return;
    }
    if (node.type !== "tag" && node.type !== "script" && node.type !== "style") return;
    const element = node as Element;
    const name = element.name.toLowerCase();
    const { children } = element;
    const style = { ...context.style };
    const color = cssColor(styleProperty(element, "color") ?? (name === "font" ? element.attribs.color : undefined));
    if (color) style.color = color;
    if (/^(bold|bolder|[6-9]00)$/i.test(styleProperty(element, "font-weight") ?? "")) style.bold = true;
    if (/^italic|oblique/i.test(styleProperty(element, "font-style") ?? "")) style.italic = true;
    const inner: Context = { ...context, style };

    if (/^h[1-6]$/.test(name)) {
      this.flush(context);
      const heading: Context = { ...inner, heading: Number(name[1]), align: alignOf(element) ?? context.align };
      for (const child of children) this.walk(child, heading);
      this.flush(heading);
      return;
    }
    if (BLOCK_CONTAINERS.has(name)) {
      this.flush(context);
      const block: Context = {
        ...inner,
        align: alignOf(element) ?? (name === "center" ? "center" : context.align),
        style: name === "summary" || name === "dt" ? { ...style, bold: true } : style
      };
      for (const child of children) this.walk(child, block);
      this.flush(block);
      return;
    }
    switch (name) {
      case "ul":
      case "ol":
        this.flush(context);
        this.blocks.push({
          kind: "list",
          ordered: name === "ol",
          start: Number.parseInt(element.attribs.start ?? "1", 10) || 1,
          items: children
            .filter((child): child is Element => child.type === "tag" && (child as Element).name.toLowerCase() === "li")
            .map(item => this.listItem(item, { style, align: undefined }))
        });
        return;
      case "pre": {
        this.flush(context);
        const text = textContent(element).replace(/\n$/, "").replace(/\t/g, "    ");
        this.blocks.push({ kind: "code", text });
        return;
      }
      case "blockquote":
        this.flush(context);
        this.blocks.push({ kind: "quote", blocks: this.nested(children, { style, align: context.align }) });
        return;
      case "dd":
        this.flush(context);
        this.blocks.push({ kind: "indent", blocks: this.nested(children, { style, align: context.align }) });
        return;
      case "table":
        this.flush(context);
        this.blocks.push({ kind: "table", rows: this.tableRows(element, style) });
        return;
      case "hr":
        this.flush(context);
        this.blocks.push({ kind: "rule" });
        return;
      case "br":
        this.inlines.push({ kind: "break" });
        return;
      case "img": {
        const { src } = element.attribs;
        if (!src) return;
        this.inlines.push({
          kind: "image",
          src,
          alt: element.attribs.alt ?? "",
          width: pixels(element.attribs.width) ?? pixels(styleProperty(element, "width")),
          height: pixels(element.attribs.height) ?? pixels(styleProperty(element, "height")),
          widthPercent: percent(element.attribs.width) ?? percent(styleProperty(element, "width")),
          style
        });
        return;
      }
      case "input":
      case "script":
      case "style":
        return;
      case "span": {
        const id = /^formula-(\d+)$/.exec(element.attribs["data-id"] ?? "");
        const formula = id && this.formulas[Number(id[1])];
        if (formula) {
          if (formula.display) {
            this.flush(context);
            this.blocks.push({ kind: "math", tex: formula.tex, align: "center" });
          } else this.inlines.push({ kind: "math", tex: formula.tex, style });
          return;
        }
        break;
      }
      case "a":
        style.link = safeLink(element.attribs.href) ?? style.link;
        if (style.link) style.color = style.color ?? "#2185d0";
        break;
      case "b":
      case "strong":
        style.bold = true;
        break;
      case "i":
      case "em":
      case "cite":
      case "var":
      case "dfn":
        style.italic = true;
        break;
      case "u":
      case "ins":
        style.underline = true;
        break;
      case "s":
      case "del":
      case "strike":
        style.strike = true;
        break;
      case "sub":
      case "sup":
        style.script = name;
        break;
      case "code":
      case "kbd":
      case "samp":
      case "tt":
        style.mono = true;
        style.code = !context.pre;
        break;
      case "small":
        style.scale = (style.scale ?? 1) * 0.85;
        break;
      case "big":
        style.scale = (style.scale ?? 1) * 1.2;
        break;
      default:
        break;
    }
    for (const child of children) this.walk(child, inner);
  }

  private listItem(item: Element, context: Context): ListItem {
    let task: ListItem["task"];
    if (/\btask-list-item\b/.test(item.attribs.class ?? "")) {
      const box = item.children.find(
        (child): child is Element => child.type === "tag" && (child as Element).name.toLowerCase() === "input"
      );
      if (box) task = { checked: box.attribs.checked !== undefined };
    }
    return { blocks: this.nested(item.children, context), task };
  }

  private tableRows(table: Element, style: TextStyle): TableCell[][] {
    const rows: TableCell[][] = [];
    const visit = (node: Element) => {
      for (const child of node.children) {
        if (child.type !== "tag") continue;
        const element = child as Element;
        const name = element.name.toLowerCase();
        if (name === "thead" || name === "tbody" || name === "tfoot") visit(element);
        else if (name === "tr")
          rows.push(
            element.children
              .filter((cell): cell is Element => cell.type === "tag" && /^t[hd]$/i.test((cell as Element).name))
              .map(cell => {
                const header = cell.name.toLowerCase() === "th";
                const cellStyle = header ? { ...style, bold: true } : style;
                const align = alignOf(cell);
                return {
                  blocks: this.nested(cell.children, { style: cellStyle, align }),
                  header,
                  colspan: Math.min(64, Math.max(1, Number.parseInt(cell.attribs.colspan ?? "1", 10) || 1)),
                  rowspan: Math.min(1000, Math.max(1, Number.parseInt(cell.attribs.rowspan ?? "1", 10) || 1)),
                  align
                };
              })
          );
      }
    };
    visit(table);
    return rows.filter(row => row.length);
  }
}

/** A Markdown text as blocks */
export function markdownBlocks(markdown: string, style: TextStyle = {}): Block[] {
  const formulas: Formula[] = [];
  const html = sanitizer.process(renderer(formulas).render(markdown ?? ""));
  const $ = load(html, null, false);
  const walker = new Walker(formulas);
  const context: Context = { style };
  for (const node of $.root().contents().toArray() as unknown as DomNode[]) walker.walk(node, context);
  walker.flush(context);
  return walker.blocks;
}
