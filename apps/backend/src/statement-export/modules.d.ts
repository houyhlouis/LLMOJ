// Packages without type definitions that the statement downloads use

declare module "svg-to-pdfkit" {
  import type PDFDocument from "pdfkit";

  function SVGtoPDF(
    doc: typeof PDFDocument.prototype,
    svg: string,
    x: number,
    y: number,
    options?: Record<string, unknown>
  ): void;
  export = SVGtoPDF;
}

declare module "linebreak" {
  class LineBreaker {
    constructor(text: string);
    nextBreak(): { position: number; required: boolean } | null;
  }
  export = LineBreaker;
}

declare module "markdown-it-math-loose" {
  import type { PluginWithOptions } from "markdown-it";

  const plugin: PluginWithOptions<Record<string, unknown>>;
  export = plugin;
}

declare module "markdown-it-merge-cells/src" {
  import type { PluginSimple } from "markdown-it";

  const plugin: PluginSimple;
  export = plugin;
}

declare module "@hackmd/markdown-it-task-lists" {
  import type { PluginWithOptions } from "markdown-it";

  const plugin: PluginWithOptions<{ enabled?: boolean }>;
  export = plugin;
}
