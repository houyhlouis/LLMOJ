import { Module } from "@nestjs/common";

import { StatementPdfService } from "./statement-pdf.service";

/** Statement downloads: the PDF worker. The problem and contest modules build the statements. */
@Module({
  providers: [StatementPdfService],
  exports: [StatementPdfService]
})
export class StatementExportModule {}
