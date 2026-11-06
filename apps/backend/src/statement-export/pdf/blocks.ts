/** What a statement's Markdown becomes before it is laid out on pages: blocks of styled inline content */

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
  /** Inline code: a light background behind the text */
  code?: boolean;
  underline?: boolean;
  strike?: boolean;
  script?: "sup" | "sub";
  /** Only http(s) and mailto links become links in the PDF */
  link?: string;
  /** A hexadecimal color ("#rrggbb") */
  color?: string;
  /** Relative to the paragraph's size */
  scale?: number;
}

export type Inline =
  | { kind: "text"; text: string; style: TextStyle }
  | { kind: "math"; tex: string; style: TextStyle }
  | {
      kind: "image";
      src: string;
      alt: string;
      width?: number;
      height?: number;
      widthPercent?: number;
      style: TextStyle;
    }
  | { kind: "break" };

export type Align = "left" | "center" | "right";

export interface TableCell {
  blocks: Block[];
  header: boolean;
  colspan: number;
  rowspan: number;
  align?: Align;
}

export interface ListItem {
  blocks: Block[];
  /** A task list item's checkbox */
  task?: { checked: boolean };
}

export type Block =
  | { kind: "paragraph"; inlines: Inline[]; align?: Align; heading?: number; size?: number; color?: string }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "code"; text: string; label?: string; note?: string }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "indent"; blocks: Block[] }
  | { kind: "table"; rows: TableCell[][] }
  | { kind: "rule" }
  | { kind: "math"; tex: string; align: Align }
  | {
      kind: "image";
      src: string;
      alt: string;
      width?: number;
      height?: number;
      widthPercent?: number;
      align: Align;
    }
  | { kind: "space"; height: number }
  | { kind: "pageBreak" }
  /** Nothing to draw: tells the page outline where a problem starts */
  | { kind: "anchor"; title: string };
