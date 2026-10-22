/*
 * CSV files people download to open in a spreadsheet: contest scoreboards and team assignment results.
 *
 * Spreadsheets run a cell that starts with = + - or @ as a formula, also after leading spaces or control characters
 * (a tab or a carriage return), and some accept the full-width forms of these signs. Such text, which may come from
 * users (names, titles, notes), gets a leading apostrophe, which spreadsheets show as text. Numbers the site computes
 * are written as they are. No escaping is known to be safe in every spreadsheet, so these files are for reading; the
 * site's API is the source for other programs.
 */

export type CsvValue = string | number | null | undefined;

// eslint-disable-next-line no-control-regex -- control characters before a formula sign
const FORMULA = /^[\s\u0000-\u001f]*[=+\-@\uff1d\uff0b\uff0d\uff20]/u;

export function csvCell(value: CsvValue): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const content = value ?? "";
  return `"${(FORMULA.test(content) ? `'${content}` : content).replace(/"/g, '""')}"`;
}

/** UTF-8 with a byte order mark, which spreadsheets need to read it as UTF-8, and CRLF line endings. */
export function csvDocument(rows: CsvValue[][]): string {
  return `\ufeff${rows.map(row => row.map(csvCell).join(",")).join("\r\n")}`;
}
