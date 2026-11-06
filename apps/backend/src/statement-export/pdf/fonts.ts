import fs from "fs";
import path from "path";

import type PDFDocument from "pdfkit";

/**
 * The fonts statements are typeset in: Noto Sans for Latin, Greek and Cyrillic text, Noto Sans SC for Chinese (and the
 * Japanese and Korean characters it has), Source Code Pro for code and samples. They come from @fontsource packages,
 * split into subsets by Unicode range; only the subsets a document uses are read and embedded (as subsets again).
 * WOFF files, not WOFF2: fontkit's subsetting draws WOFF2's transformed glyphs wrong.
 */

export type FontRole = "text" | "mono";

interface Face {
  key: string;
  file: string;
  ranges: [number, number][];
}

type Family = "sans" | "cjk" | "mono";

function packageDirectory(name: string) {
  return path.dirname(require.resolve(`${name}/package.json`));
}

function parseRanges(text: string): [number, number][] {
  return text.split(",").map(range => {
    const [from, to] = range.trim().replace(/^U\+/i, "").split("-");
    // A wildcard range ("4??") covers every value of its question marks
    const low = parseInt(from.replace(/\?/g, "0"), 16);
    const high = parseInt((to ?? from).replace(/\?/g, "f"), 16);
    return [low, high];
  });
}

const FAMILIES: Record<
  Family,
  { package: string; id: string; subsets: (keys: string[]) => string[]; italic: boolean }
> = {
  sans: {
    package: "@fontsource/noto-sans",
    id: "noto-sans",
    subsets: () => ["latin", "latin-ext", "greek", "greek-ext", "cyrillic", "cyrillic-ext", "vietnamese", "devanagari"],
    italic: true
  },
  // Only the numbered slices: they hold the Chinese characters and the punctuation Chinese text uses
  cjk: {
    package: "@fontsource/noto-sans-sc",
    id: "noto-sans-sc",
    subsets: keys => keys.filter(key => /^\[\d+\]$/.test(key)),
    italic: false
  },
  mono: {
    package: "@fontsource/source-code-pro",
    id: "source-code-pro",
    subsets: () => ["latin", "latin-ext", "greek", "greek-ext", "cyrillic", "cyrillic-ext", "vietnamese"],
    italic: false
  }
};

/** Zero-width joiners and variation selectors, which belong to the character before them */
function isJoiner(codePoint: number) {
  return codePoint === 0x200c || codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f);
}

/** Punctuation Chinese text sets full-width: in a Chinese statement it comes from the Chinese font */
const CJK_PUNCTUATION = /[\u2014\u2015\u2018-\u201f\u2026\u00b7]/u;

/** The font files, read once per process: which file has which characters */
export class FontLibrary {
  private static instance: FontLibrary;

  static get(): FontLibrary {
    return (FontLibrary.instance ??= new FontLibrary());
  }

  private readonly faces = new Map<string, Face[]>();

  private constructor() {
    for (const [family, spec] of Object.entries(FAMILIES) as [Family, (typeof FAMILIES)[Family]][]) {
      const directory = packageDirectory(spec.package);
      const unicode: Record<string, string> = JSON.parse(fs.readFileSync(path.join(directory, "unicode.json"), "utf8"));
      for (const weight of [400, 700])
        for (const italic of spec.italic ? [false, true] : [false]) {
          const faces: Face[] = [];
          for (const subset of spec.subsets(Object.keys(unicode))) {
            if (!unicode[subset]) continue;
            const name = subset.replace(/^\[|\]$/g, "");
            const file = path.join(
              directory,
              "files",
              `${spec.id}-${name}-${weight}-${italic ? "italic" : "normal"}.woff`
            );
            if (!fs.existsSync(file)) continue;
            faces.push({
              key: `${family}-${name}-${weight}${italic ? "i" : ""}`,
              file,
              ranges: parseRanges(unicode[subset])
            });
          }
          this.faces.set(`${family}-${weight}-${italic}`, faces);
        }
    }
  }

  face(family: Family, codePoint: number, bold: boolean, italic: boolean): Face | null {
    const faces =
      this.faces.get(`${family}-${bold ? 700 : 400}-${italic && FAMILIES[family].italic}`) ??
      this.faces.get(`${family}-400-false`);
    return faces.find(face => face.ranges.some(([low, high]) => codePoint >= low && codePoint <= high)) ?? null;
  }

  fallback(bold: boolean): Face {
    return this.faces.get(`sans-${bold ? 700 : 400}-false`)[0];
  }
}

export interface FontRun {
  text: string;
  font: string;
}

/** A document's fonts: chooses a font for each character and registers the files it uses with the document */
export class DocumentFonts {
  private readonly registered = new Set<string>();

  private readonly library = FontLibrary.get();

  constructor(
    private readonly doc: typeof PDFDocument.prototype,
    /** The statement's own language: Chinese text sets its punctuation full-width */
    private readonly cjkPunctuation: boolean
  ) {}

  private use(face: Face) {
    if (!this.registered.has(face.key)) {
      this.doc.registerFont(face.key, face.file);
      this.registered.add(face.key);
    }
    return face.key;
  }

  /** The font for one character */
  fontFor(codePoint: number, role: FontRole, bold: boolean, italic: boolean): string {
    const order: Family[] = role === "mono" ? ["mono", "cjk", "sans"] : ["sans", "cjk"];
    if (this.cjkPunctuation && CJK_PUNCTUATION.test(String.fromCodePoint(codePoint))) order.unshift("cjk");
    for (const family of order) {
      const face = this.library.face(family, codePoint, bold, italic);
      if (face) return this.use(face);
    }
    return this.use(this.library.fallback(bold));
  }

  /**
   * `text` split into runs of one font each. Marks, joiners and variation selectors stay with the character before
   * them.
   */
  runs(text: string, role: FontRole, bold = false, italic = false): FontRun[] {
    const runs: FontRun[] = [];
    let current: FontRun = null;
    for (const character of text) {
      const codePoint = character.codePointAt(0);
      const attached = current && (/^\p{M}$/u.test(character) || isJoiner(codePoint));
      // Spaces take the font around them, so a run isn't split at every space
      const font =
        attached || (current && character === " ") ? current.font : this.fontFor(codePoint, role, bold, italic);
      if (current && current.font === font) current.text += character;
      else runs.push((current = { text: character, font }));
    }
    return runs;
  }

  /** Width of `text` in points at `size`, in the fonts `runs` chooses */
  width(text: string, size: number, role: FontRole, bold = false, italic = false) {
    let width = 0;
    for (const run of this.runs(text, role, bold, italic)) {
      this.doc.font(run.font).fontSize(size);
      width += this.doc.widthOfString(run.text);
    }
    return width;
  }
}
