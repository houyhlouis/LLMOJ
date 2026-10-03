const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2019,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
      }
    }).outputText,
    filename
  );
const { resolveAiFileIo, detectAiFileIo } = require("./ai-file-io.ts");
const files = { inputFilename: "homework.in", outputFilename: "homework.out" };
const statement = instruction => [
  {
    locale: "en_US",
    contentSections: [
      { type: "Text", sectionTitle: "I/O", text: instruction },
      { type: "Text", sectionTitle: "Input", text: "Input file: `homework.in`" },
      { type: "Text", sectionTitle: "Output", text: "Output file: `homework.out`" }
    ]
  }
];
test("negated standard-I/O mentions preserve named input and output", () => {
  for (const instruction of [
    "Do not use standard input or standard output.",
    "Don't use standard input and standard output.",
    "Never read from standard input; never write to standard output.",
    "Standard input and standard output must not be used.",
    "The input must not be read from standard input. The output must not be written to standard output.",
    "不要使用标准输入和标准输出。",
    "禁止使用标准输入、标准输出。"
  ])
    assert.deepEqual(resolveAiFileIo({}, statement(instruction)), files, instruction);
});
test("positive standard-I/O adaptation still overrides historical file declarations", () => {
  for (const instruction of [
    "Use standard input and standard output.",
    "Do not use files; use standard input and standard output.",
    "Do not use files, but use standard input and standard output.",
    "本题不使用文件，使用标准输入和标准输出。",
    "本题采用标准输入和标准输出。"
  ])
    assert.equal(resolveAiFileIo({}, statement(instruction)), null, instruction);
});

const only = (text, title = "Description") => [
  { locale: "zh_CN", contentSections: [{ type: "Text", sectionTitle: title, text }] }
];
test("ordinary file-content prose never declares a submission filename", () => {
  for (const text of [
    "输入文件的第一行包含一个整数 n。\n输出文件包含一个整数，表示答案。",
    "输入文件共有 n 行，第一行为 n。\n输出文件为一个整数。",
    "The input file contains a single integer n.\nThe output file contains one integer.",
    "Input file: a positive integer n.\nOutput file: one integer.",
    "Input file should contain n integers.\nOutput file must contain the answer.",
    "Input: N integers\nOutput: answer"
  ])
    assert.deepEqual(detectAiFileIo(only(text)), { kind: "unspecified", fileIo: null }, text);
});
test("explicit file declarations accept Chinese quotes, parentheses, headers and Markdown tables", () => {
  for (const text of [
    "输入文件（homework.in）\n输出文件（homework.out）",
    "输入文件“homework.in”\n输出文件‘homework.out’",
    "### **输入文件名**：`homework.in`\n### **输出文件名**：`homework.out`",
    "输入文件\nhomework.in\n输出文件\nhomework.out",
    "The input file is homework.in. The output file is homework.out.",
    "INPUT FORMAT (file homework.in)\nOUTPUT FORMAT (file homework.out)",
    "| 输入文件 | 输出文件 |\n| --- | --- |\n| homework.in | homework.out |",
    "| 输入文件名 | homework.in |\n| 输出文件名 | homework.out |",
    "| Input file | Output file | Memory |\n| :---: | ---: | --- |\n| `homework.in` | `homework.out` | 256 MiB |"
  ])
    assert.deepEqual(detectAiFileIo(only(text)), { kind: "named", fileIo: files }, text);
});
test("sample, archive and code references cannot turn local files into submission I/O", () => {
  for (const text of [
    "附件中的输入文件 sample.in 和输出文件 sample.out 仅供本地测试。",
    "Sample input file: sample.in\nSample output file: sample.out",
    "Input file: example.in (attachment example)\nOutput file: example.out (local testing)",
    "```text\nInput file: example.in\nOutput file: example.out\n```",
    "Source: https://example.org/input-file/homework.in https://example.org/output-file/homework.out"
  ])
    assert.equal(resolveAiFileIo({}, only(text)), null, text);
  for (const title of ["附件", "样例说明", "Samples", "Local testing", "Attachments"])
    assert.equal(resolveAiFileIo({}, only("Input file: sample.in\nOutput file: sample.out", title)), null, title);
  assert.deepEqual(
    resolveAiFileIo({}, only("Input file: sample.in\nOutput file: sample.out")),
    { inputFilename: "sample.in", outputFilename: "sample.out" },
    "filename alone does not imply example context"
  );
});
test("explicit standard stream aliases override historical names without confusing freopen code", () => {
  for (const text of [
    "输入文件：stdin\n输出文件：stdout",
    "Input file: `stdin`\nOutput file: `stdout`",
    "| Input file | stdin |\n| Output file | stdout |"
  ]) {
    assert.deepEqual(detectAiFileIo([...statement(""), ...only(text)]), { kind: "standard", fileIo: null });
    assert.equal(resolveAiFileIo({}, only(text), files), null);
  }
  assert.deepEqual(
    resolveAiFileIo({ fileIo: files }, only("Use standard input and standard output.")),
    files,
    "already configured named I/O remains authoritative"
  );
});
test("named file detection keeps ambiguity, partial names and path validation strict", () => {
  assert.throws(
    () => detectAiFileIo(only("Input file: homework.in\nOutput file: homework.out\nInput file: other.in")),
    /INVALID_AI_FILE_IO/
  );
  assert.throws(() => detectAiFileIo(only("Input file: homework.in")), /UNVERIFIED_AI_FILE_IO/);
  assert.throws(() => detectAiFileIo(only("Input file: homework.in\nOutput file: stdout")), /UNVERIFIED_AI_FILE_IO/);
  for (const invalid of ["../input", "/tmp/input.in", ".", "..", "x".repeat(256)])
    assert.throws(
      () => detectAiFileIo(only(`Input file: ${invalid}\nOutput file: homework.out`)),
      /INVALID_AI_FILE_IO/,
      invalid
    );
  assert.throws(
    () => resolveAiFileIo({}, only("Read n integers and print the result."), files),
    /UNVERIFIED_AI_FILE_IO/
  );
  assert.throws(
    () =>
      resolveAiFileIo({}, only("Input file: homework.in\nOutput file: homework.out"), {
        inputFilename: "guessed.in",
        outputFilename: "guessed.out"
      }),
    /UNVERIFIED_AI_FILE_IO/
  );
});

test("code fences of different lengths stay non-evidence and quoted filenames are not truncated", () => {
  for (const fenced of [
    "````text\nInput file: fake.in\nOutput file: fake.out\n```\n",
    "~~~\nInput file: fake.in\nOutput file: fake.out\n~~~~",
    "```\nInput file: fake.in\nOutput file: fake.out"
  ])
    assert.equal(resolveAiFileIo({}, only(fenced)), null);
  assert.deepEqual(resolveAiFileIo({}, only('Input file: "my data.in"\nOutput file: “my data.out”')), {
    inputFilename: "my data.in",
    outputFilename: "my data.out"
  });
  assert.deepEqual(resolveAiFileIo({}, only("输入文件（`homework.in`）\n输出文件（`homework.out`）")), files);
});

test("OCR preserves same-line Chinese and English input/output declarations", () => {
  const expected = { inputFilename: "a.in", outputFilename: "a.out" };
  for (const separator of [" ", "   ", ", ", "，", "; ", "；"]) {
    for (const [input, output] of [
      ["输入文件：a.in", "输出文件：a.out"],
      ["Input file: a.in", "Output file: a.out"]
    ]) {
      const line = input + separator + output;
      assert.deepEqual(resolveAiFileIo({}, only(line), expected), expected, line);
    }
  }
  assert.deepEqual(resolveAiFileIo({}, only("输入文件：a.in 输出文件：a.out fileio: a"), expected), expected);
  assert.deepEqual(resolveAiFileIo({}, only("输入文件：“a.in” 输出文件：“a.out”"), expected), expected);
  assert.deepEqual(resolveAiFileIo({}, only("输入文件：stdin 输出文件：stdout")), null);
  for (const line of [
    "Sample input file: sample.in; Output file: sample.out",
    "Input file: sample.in, Output file: sample.out (attachment example)",
    "附件中的输入文件：sample.in；输出文件：sample.out"
  ])
    assert.equal(resolveAiFileIo({}, only(line)), null, line);
});


test("shared standard modifier and slash declarations identify both streams without weakening evidence rules", () => {
  const { detectImportFileIoEvidence } = require("./ai-import-metadata.ts");
  for (const text of ["Standard input/output.", "Use standard input and output.", "Standard output / input.", "Standard input & output.", "Standard I/O."])
    assert.deepEqual(detectImportFileIoEvidence(text), { kind: "standard", fileIo: null }, text);
  for (const text of ["Do not use standard input/output.", "Standard input/output are not permitted.", "Sample uses standard input/output.", "```text\nStandard input/output.\n```"])
    assert.deepEqual(detectImportFileIoEvidence(text), { kind: "unspecified", fileIo: null }, text);
});


test("explicit read/write file instructions preserve both exact filenames", () => {
  const { detectImportFileIoEvidence } = require("./ai-import-metadata.ts");
  for (const text of [
    "Read input.txt and write output.txt (required file input/output).",
    "Read from input.txt and write to output.txt.",
    "You must read input from `input.txt` and write output to `output.txt`.",
    "Read input.txt; write output.txt.",
    "Read input.txt. Write output.txt."
  ]) assert.deepEqual(detectImportFileIoEvidence(text), { kind: "named", fileIo: { inputFilename: "input.txt", outputFilename: "output.txt" } }, text);
  for (const text of [
    "Do not read sample.in and write sample.out.",
    "Read sample.in and write sample.out for local testing.",
    "The attachment explains: read sample.in and write sample.out.",
    "Alice reads data.in and writes data.out.",
    "Read n integers and write the answer.",
    "`Read fake.in and write fake.out`",
    "```cpp\nRead fake.in and write fake.out\n```"
  ]) assert.deepEqual(detectImportFileIoEvidence(text), { kind: "unspecified", fileIo: null }, text);
  assert.throws(() => detectImportFileIoEvidence("Read ../secret.in and write output.txt."), /INVALID_AI_FILE_IO/);
  assert.throws(() => detectImportFileIoEvidence("Read input.txt and write output.txt.\nInput file: different.in"), /INVALID_AI_FILE_IO/);
});


test("sample and attachment Markdown subsection scope cannot declare contestant IO", () => {
  for(const heading of ['Sample files','Attachments','样例文件']) {
    const example='## '+heading+'\nInput file: 01.in\nOutput file: 01.out';
    assert.deepEqual(detectAiFileIo(only(example)),{kind:'unspecified',fileIo:null});
    assert.deepEqual(detectAiFileIo(only(example+'\n## Submission\nInput file: task.in\nOutput file: task.out')),{kind:'named',fileIo:{inputFilename:'task.in',outputFilename:'task.out'}});
  }
});


test("nested sample headings cannot escape an enclosing attachment section", () => {
  const local = "## Attachments\n### Samples\nSee files.\n### Local runner\nInput file: local.in\nOutput file: local.out";
  assert.deepEqual(detectAiFileIo(only(local)), { kind: "unspecified", fileIo: null });
  assert.deepEqual(detectAiFileIo(only(local + "\n## Submission\nInput file: task.in\nOutput file: task.out")), {
    kind: "named", fileIo: { inputFilename: "task.in", outputFilename: "task.out" }
  });
});

test("Setext sample and attachment headings preserve scope until a peer or parent heading", () => {
  for (const marker of ["-----------", "==========="]) {
    const local = "Attachments\n" + marker + "\n### Samples\nInput file: 01.in\nOutput file: 01.out\n### Local runner\nStandard input/output.";
    assert.deepEqual(detectAiFileIo(only(local)), { kind: "unspecified", fileIo: null });
    assert.deepEqual(detectAiFileIo(only(local + "\nSubmission\n" + marker + "\nInput file: task.in\nOutput file: task.out")), {
      kind: "named", fileIo: { inputFilename: "task.in", outputFilename: "task.out" }
    });
  }
});


test("a single explicit standard stream without any filename is a valid standard IO declaration", () => {
  const { detectImportFileIoEvidence } = require("./ai-import-metadata.ts");
  for (const text of [
    "The input is given from Standard Input in the following format:",
    "The input is given from Standard Input in the following format:\nN M\nx_1 y_1\nOutput\nPrint M lines. The i-th line should contain S_i.",
    "Standard input only.", "Write the answer to standard output.",
    "Input file: stdin", "Output file: stdout",
    "输入由标准输入给出。", "将答案写入标准输出。"
  ]) {
    assert.deepEqual(detectAiFileIo(only(text)), { kind: "standard", fileIo: null }, text);
    assert.deepEqual(detectImportFileIoEvidence(text), { kind: "standard", fileIo: null }, text);
  }
});

test("single-stream stdio evidence does not promote negations or local examples", () => {
  const { detectImportFileIoEvidence } = require("./ai-import-metadata.ts");
  for (const text of [
    "Do not read from standard input.", "Standard output must not be used.",
    "不能使用标准输入。", "不要使用标准输出。",
    "The sample uses standard input.", "The example writes to standard output.",
    "## Attachments\nRead from standard input.",
    "## Sample Input\nThe input is given from Standard Input in the following format:",
    "```text\nThe input is given from Standard Input in the following format:\n```"
  ]) {
    assert.deepEqual(detectAiFileIo(only(text)), { kind: "unspecified", fileIo: null }, text);
    assert.deepEqual(detectImportFileIoEvidence(text), { kind: "unspecified", fileIo: null }, text);
  }
});

test("a standard stream combined with a named stream remains an unsupported mixed IO contract", () => {
  const { detectImportFileIoEvidence } = require("./ai-import-metadata.ts");
  for (const text of [
    "The input is given from Standard Input in the following format:\nOutput file: answer.out",
    "Input file: task.in\nWrite to standard output.",
    "Input file: stdin\nOutput file: answer.out",
    "Input file: task.in\nOutput file: stdout"
  ]) {
    assert.throws(() => detectAiFileIo(only(text)), /UNVERIFIED_AI_FILE_IO/, text);
    assert.throws(() => detectImportFileIoEvidence(text), /UNVERIFIED_AI_FILE_IO/, text);
  }
});
