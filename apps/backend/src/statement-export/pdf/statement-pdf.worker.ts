import { parentPort } from "worker_threads";

import { renderStatementsPdf, PdfBook } from "./statement-pdf";

/**
 * Typesets statement PDFs off the backend's main thread (StatementPdfService starts it): MathJax, fonts and layout
 * take seconds of CPU for a contest, and a worker can be stopped when it takes too long.
 */
parentPort.on("message", async ({ id, book }: { id: number; book: PdfBook }) => {
  try {
    const result = await renderStatementsPdf(book);
    // A copy that owns its memory, so it can be transferred rather than copied again
    const pdf = new Uint8Array(result.pdf);
    parentPort.postMessage({ id, pdf, pages: result.pages, warnings: result.warnings }, [pdf.buffer]);
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
