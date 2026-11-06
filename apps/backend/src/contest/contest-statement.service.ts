import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource } from "typeorm";

import { ContestProblemEntity } from "./contest-problem.entity";
import { ContestAccessService } from "./contest-access.service";
import { ContestProblemService } from "./contest-problem.service";

import { UserEntity } from "../user/user.entity";
import { ProblemService } from "../problem/problem.service";
import { FileService, MinioSignFor } from "../file/file.service";
import { Locale } from "../common/locale.type";
import { buildStatement, statementLabels } from "../statement-export/statement";
import { statementMarkdown } from "../statement-export/statement-markdown";
import { UniqueNames, safeFileName } from "../statement-export/export-names";
import { StatementPdfService } from "../statement-export/statement-pdf.service";

/**
 * A contest's statements to download: one problem's as Markdown, or all of them as an archive (a PDF of every
 * statement in contest order, and a folder per problem with its samples and attachments). Only what the contest's
 * pages show the viewer goes in, with the same checks: the contest's problems from its start (managers before),
 * attachments with the privilege to download them, never test data or other judge-only files.
 */

const RULES: Record<string, string> = { noi: "NOI / OI", ioi: "IOI", acm: "ICPC / XCPC", strictioi: "Strict IOI" };

export function problemLabel(index: number) {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/** "2026-11-06 14:00" in the viewer's time zone, and that zone's offset ("UTC+08:00") */
export function formatContestTime(date: Date, timeZone: string) {
  let zone = "UTC";
  try {
    zone = new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone;
  } catch {
    // An unknown zone: UTC
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset"
    })
      .formatToParts(date)
      .map(part => [part.type, part.value])
  );
  const offset = String(parts.timeZoneName ?? "GMT").replace(/^GMT/, "UTC") || "UTC";
  return {
    time: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`,
    offset: offset === "UTC" ? "UTC+00:00" : offset
  };
}

export interface ArchiveFile {
  name: string;
  /** A sample's text (UTF-8) */
  text?: string;
  /** An attachment's signed download link */
  url?: string;
  size?: number;
}

@Injectable()
export class ContestStatementService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly access: ContestAccessService,
    private readonly contestProblems: ContestProblemService,
    private readonly problems: ProblemService,
    private readonly files: FileService,
    private readonly pdf: StatementPdfService
  ) {}

  private async rows(contestId: number) {
    return await this.db
      .getRepository(ContestProblemEntity)
      .find({ where: { contestId }, order: { position: "ASC", id: "ASC" } });
  }

  /** One problem's statement as its contest page shows it, and the attachments the viewer may download */
  private async statement(
    user: UserEntity,
    manager: boolean,
    row: ContestProblemEntity,
    index: number,
    locale: string,
    canDownload: boolean
  ) {
    const problem = await row.problem;
    const selected = problem.locales.includes(locale as Locale) ? (locale as Locale) : problem.locales[0];
    const [[judgeInfo], [preprocessed], title, sections, samples] = await Promise.all([
      this.problems.getProblemJudgeInfo(problem),
      this.problems.getProblemPreprocessedJudgeInfo(problem),
      row.title ? Promise.resolve(row.title) : this.problems.getProblemLocalizedTitle(problem, selected),
      this.problems.getProblemLocalizedContent(problem, selected),
      this.problems.getProblemSamples(problem)
    ]);
    const attachments = canDownload
      ? await this.contestProblems.visibleAttachments(user, manager, row, problem, judgeInfo)
      : [];
    const statement = buildStatement({
      locale,
      contentLocale: selected,
      label: problemLabel(index),
      title,
      type: problem.type,
      judgeInfo: preprocessed as Parameters<typeof buildStatement>[0]["judgeInfo"],
      contestFiles: { input: row.inputFilename, output: row.outputFilename },
      sections,
      samples,
      files: attachments.map(file => file.filename)
    });
    return { statement, attachments };
  }

  /** One contest problem's statement as Markdown */
  async markdown(user: UserEntity, id: number, problemId: number, locale: string) {
    const { manager } = await this.access.get(user, id, true);
    const rows = await this.rows(id);
    const index = rows.findIndex(row => row.id === problemId);
    if (index < 0) throw new NotFoundException();
    const canDownload = await this.access.canDownloadAttachments(user);
    const { statement } = await this.statement(user, manager, rows[index], index, locale, canDownload);
    return {
      filename: `${safeFileName(statement.title, statementLabels(locale).untitled)}.md`,
      markdown: statementMarkdown(statement)
    };
  }

  /**
   * Everything for the contest's archive: its PDF (base64) and what goes in each problem's folder. The browser fetches
   * attachments from their signed links and writes the ZIP.
   */
  async archive(user: UserEntity, id: number, locale: string, timeZone: string) {
    const { contest, manager } = await this.access.get(user, id, true);
    const labels = statementLabels(locale);
    const rows = await this.rows(id);
    if (!rows.length) throw new NotFoundException({ error: "NO_PROBLEMS", message: "The contest has no problems" });
    const canDownload = await this.access.canDownloadAttachments(user);
    const problems = await Promise.all(
      rows.map((row, index) => this.statement(user, manager, row, index, locale, canDownload))
    );

    // Folder names are the problems' own names; "statements.pdf" is taken at the top
    const top = new UniqueNames();
    top.reserve("statements.pdf");
    const folders: { name: string; label: string; files: ArchiveFile[] }[] = [];
    const sampleFiles: { input: string; output: string }[][] = [];
    let attachments = 0;
    const signed = await Promise.all(
      problems.map(problem =>
        Promise.all(
          problem.attachments.map(file =>
            this.files.signDownloadLink({
              uuid: file.uuid,
              downloadFilename: file.filename,
              signFor: MinioSignFor.UserDownload
            })
          )
        )
      )
    );
    for (const [index, { statement, attachments: files }] of problems.entries()) {
      const name = top.take(statement.title, labels.untitled);
      const inside = new UniqueNames();
      const entries: ArchiveFile[] = [];
      const names: { input: string; output: string }[] = [];
      for (const sample of statement.samples) {
        const input = `sample${sample.number}.in`;
        const output = `sample${sample.number}.ans`;
        inside.reserve(input);
        inside.reserve(output);
        entries.push({ name: input, text: sample.input }, { name: output, text: sample.output });
        names.push({ input, output });
      }
      files.forEach((file, fileIndex) =>
        entries.push({
          name: inside.take(file.filename, "attachment", { keepExtension: true }),
          size: file.size,
          url: signed[index][fileIndex]
        })
      );
      attachments += files.length;
      folders.push({ name, label: statement.label, files: entries });
      sampleFiles.push(names);
    }

    const start = formatContestTime(contest.startTime, timeZone);
    const end = formatContestTime(contest.endTime, timeZone);
    const zh = locale === "zh_CN";
    const result = await this.pdf.render({
      locale,
      title: contest.title,
      subtitle: contest.subtitle?.trim() || undefined,
      details: [
        `${labels.time}${labels.colon}${start.time} — ${end.time} (${start.offset})`,
        `${zh ? "赛制" : "Rules"}${labels.colon}${RULES[contest.rule] ?? contest.rule}`
      ],
      description: contest.description,
      problems: problems.map((problem, index) => ({ statement: problem.statement, sampleFiles: sampleFiles[index] }))
    });
    return {
      filename: `${safeFileName(contest.title, `contest-${contest.id}`)}.zip`,
      pdf: result.pdf.toString("base64"),
      pages: result.pages,
      warnings: result.warnings,
      folders,
      // Attachments the viewer can't download aren't listed at all; say that some exist
      attachmentsWithheld: !canDownload && rows.some(row => row.attachments?.length > 0),
      attachments
    };
  }
}
