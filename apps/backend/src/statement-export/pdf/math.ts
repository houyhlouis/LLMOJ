import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import "mathjax-full/js/input/tex/base/BaseConfiguration.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import "mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "mathjax-full/js/input/tex/colorv2/ColorV2Configuration.js";
import "mathjax-full/js/input/tex/html/HtmlConfiguration.js";
import "mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration.js";
import "mathjax-full/js/input/tex/physics/PhysicsConfiguration.js";

/**
 * TeX formulas as SVG, with the TeX packages the site's pages load (markdown/mathjax.ts), so a formula looks the same
 * in a PDF as on the page. Glyphs are paths (no font cache), which svg-to-pdfkit draws.
 */

export interface MathBox {
  svg: string;
  /** In ems of the surrounding text: the width, the height above the baseline and the depth below it */
  width: number;
  height: number;
  depth: number;
  /** The formula didn't parse: the box shows MathJax's error message */
  error?: boolean;
}

const PACKAGES = ["base", "ams", "boldsymbol", "colorv2", "html", "noundefined", "physics"];

export class MathRenderer {
  private readonly adaptor = liteAdaptor();

  private readonly tex: TeX<unknown, unknown, unknown>;

  private readonly document: ReturnType<typeof mathjax.document>;

  private readonly cache = new Map<string, MathBox | null>();

  constructor() {
    RegisterHTMLHandler(this.adaptor);
    this.tex = new TeX({ packages: PACKAGES, formatError: (_jax: unknown, error: Error) => this.error(error) });
    this.document = mathjax.document("", {
      InputJax: this.tex,
      OutputJax: new SVG({ fontCache: "none" })
    });
  }

  private error(error: Error): never {
    throw error;
  }

  /** The formula's box, or null when MathJax can't typeset it (the PDF shows its TeX instead) */
  render(source: string, display: boolean): MathBox | null {
    const key = `${display ? "D" : "I"}${source}`;
    if (this.cache.has(key)) return this.cache.get(key);
    let box: MathBox | null = null;
    try {
      this.tex.reset();
      const node = this.document.convert(source, { display, em: 16, ex: 8, containerWidth: 1280 });
      const svg = this.adaptor.innerHTML(node);
      const viewBox = /viewBox="([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+)"/.exec(svg);
      if (viewBox) {
        const [, , minY, width, height] = viewBox.map(Number);
        box = { svg, width: width / 1000, height: -minY / 1000, depth: (height + minY) / 1000 };
      }
    } catch {
      box = null;
    }
    if (this.cache.size > 4096) this.cache.clear();
    this.cache.set(key, box);
    return box;
  }
}
