import { Statement, describeIo, statementLabels } from "./statement";

/**
 * A statement as one Markdown file: the title, limits, input and output, every section the page shows with its text
 * exactly as written (formulas, images, tables and HTML stay as they are), each sample's input and output as code
 * blocks, and the names of the files that come with it.
 */

// Characters that would change how a title or section heading renders
function escapeText(text: string) {
  return text.replace(/[\\`*_<>[\]|~$]/g, "\\$&").replace(/^([#+-]|\d+\.)(?=\s|$)/, "\\$1");
}

/** A fenced code block that holds `text` exactly, whatever backticks it contains */
export function codeBlock(text: string, info = "") {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${fence}`;
}

function inlineCode(text: string) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const ticks = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

export function statementHeading(statement: Pick<Statement, "label" | "title">) {
  return statement.label ? `${statement.label}. ${statement.title}` : statement.title;
}

export function statementMarkdown(statement: Statement): string {
  const labels = statementLabels(statement.locale);
  const out: string[] = [];
  out.push(`# ${escapeText(statementHeading(statement))}`, "");
  const facts: string[] = [];
  const { colon } = labels;
  if (statement.timeLimit) facts.push(`- ${labels.timeLimit}${colon}${statement.timeLimit} ms`);
  if (statement.memoryLimit) facts.push(`- ${labels.memoryLimit}${colon}${statement.memoryLimit} MiB`);
  if (statement.io.kind === "file")
    facts.push(
      `- ${labels.io}${colon}${labels.fileIo}${labels.open}${labels.inputFile}${colon}${inlineCode(statement.io.input)}${labels.comma}${labels.outputFile}${colon}${inlineCode(statement.io.output)}${labels.close}`
    );
  else facts.push(`- ${labels.io}${colon}${describeIo(statement.io, labels)}`);
  if (statement.source)
    facts.push(
      `- ${labels.source}${colon}${/^https?:\/\/\S+$/i.test(statement.source) ? `<${statement.source}>` : escapeText(statement.source)}`
    );
  out.push(...facts, "");
  for (const section of statement.sections) {
    out.push(`## ${escapeText(section.title)}`, "");
    if (section.kind === "sample") {
      out.push(`**${labels.input}**`, "", codeBlock(section.sample.input), "");
      out.push(`**${labels.output}**`, "", codeBlock(section.sample.output), "");
    }
    const text = section.text?.replace(/\s+$/, "");
    if (text) out.push(text, "");
  }
  if (statement.files.length) {
    out.push(`## ${labels.files}`, "");
    for (const file of statement.files) out.push(`- ${inlineCode(file)}`);
    out.push("");
  }
  return out.join("\n");
}
