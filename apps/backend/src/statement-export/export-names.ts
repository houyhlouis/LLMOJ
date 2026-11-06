/**
 * File and folder names for downloaded statements and contest archives. A name is the problem's own title: only
 * characters that are invalid or unsafe in a file name on Windows, macOS or Linux are replaced, and names that would
 * collide when extracted (on a case-insensitive file system too) get " (2)", " (3)" and so on.
 */

// Invalid on Windows (and "/" everywhere), control characters, and the bidirectional controls that can make a name
// look like another one (".exe" shown as "exe.")
// eslint-disable-next-line no-control-regex
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f\u007f\u0080-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

// Device names Windows reserves, with or without an extension ("CON.txt" is as reserved as "CON")
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

// A name's length in UTF-8 bytes stays below the 255 most file systems allow, leaving room for " (99)" and for an
// extension; Windows paths are short too (a folder in Downloads plus this name)
const MAXIMUM_BYTES = 180;

function truncate(name: string, maximumBytes: number) {
  let result = "";
  let bytes = 0;
  for (const character of name) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maximumBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

/**
 * A safe file or folder name for `name`, or `fallback` when nothing is left of it. Only unsafe characters change:
 * they become "_". Spaces and dots at either end are removed (Windows drops trailing ones, and a leading dot hides a
 * file), and reserved device names get a "_".
 */
export function safeFileName(name: string, fallback: string): string {
  const clean = (text: string) =>
    truncate(
      String(text ?? "")
        .normalize("NFC")
        .replace(UNSAFE, "_")
        .replace(/^[\s.]+/, ""),
      MAXIMUM_BYTES
    ).replace(/[\s.]+$/, "");
  let result = clean(name) || clean(fallback) || "_";
  if (RESERVED.test(result)) result = result.replace(/^([^.]*)/, "$1_");
  return result;
}

/** The key under which two names collide when extracted: Windows and macOS compare names case-insensitively */
export function nameKey(name: string) {
  return name.normalize("NFC").toLowerCase();
}

/**
 * Hands out unique names in one folder. `reserve` takes a name that must stay as it is (a sample file, the PDF);
 * `take` returns the safe form of a name, numbered when it's already taken: "test", "test (2)"; "a.txt", "a (2).txt".
 */
export class UniqueNames {
  private readonly used = new Set<string>();

  reserve(name: string) {
    this.used.add(nameKey(name));
  }

  has(name: string) {
    return this.used.has(nameKey(name));
  }

  take(name: string, fallback: string, options: { keepExtension?: boolean } = {}): string {
    const safe = safeFileName(name, fallback);
    const dot = options.keepExtension ? safe.lastIndexOf(".") : -1;
    const [stem, extension] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ""];
    for (let index = 1; ; index++) {
      const candidate = index === 1 ? safe : `${stem} (${index})${extension}`;
      if (!this.has(candidate) && !RESERVED.test(candidate)) {
        this.reserve(candidate);
        return candidate;
      }
    }
  }
}
