const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const repository = path.resolve(__dirname, "../../../..");
const parsed = new Map();
function source(filename) {
  if (!parsed.has(filename)) parsed.set(filename, ts.createSourceFile(filename,
    fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
  return parsed.get(filename);
}
function productionFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return ["node_modules", "dist", "test"].includes(entry.name) ? [] : productionFiles(filename);
    return /\.(?:ts|tsx|js)$/.test(entry.name) && !/\.(?:test|fixture|d)\./.test(entry.name) ? [filename] : [];
  });
}
function initializer(node, name) {
  for (let scope = node; scope; scope = scope.parent) {
    for (const statement of scope.statements || []) {
      if (!ts.isVariableStatement(statement)) continue;
      const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === name);
      if (declaration?.initializer) return declaration.initializer;
    }
  }
  const file = node.getSourceFile();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.moduleSpecifier.text.startsWith(".")) continue;
    const binding = statement.importClause?.namedBindings;
    if (!binding || !ts.isNamedImports(binding)) continue;
    const imported = binding.elements.find(item => item.name.text === name);
    if (!imported) continue;
    const filename = path.resolve(path.dirname(file.fileName), statement.moduleSpecifier.text + ".ts");
    if (!fs.existsSync(filename)) continue;
    const importedName = imported.propertyName?.text || imported.name.text;
    const target = source(filename);
    return initializer(target, importedName);
  }
}
function fragments(node, visited = new Set()) {
  if (!node || visited.has(node)) return [];
  visited.add(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.flatMap(span => [
    ...fragments(span.expression, visited), span.literal.text
  ])];
  if (ts.isIdentifier(node)) return fragments(initializer(node, node.text), visited);
  if (ts.isConditionalExpression(node)) return [...fragments(node.whenTrue, visited), ...fragments(node.whenFalse, visited)];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return fragments(node.expression, visited);
  if (ts.isTaggedTemplateExpression(node)) return fragments(node.template, visited);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return [...fragments(node.left, visited), ...fragments(node.right, visited)];
  // Calls such as JSON.stringify(snapshot), search results and source text are
  // original-language problem/user data, rather than repository instructions.
  return [];
}
function promptRecords() {
  const records = [];
  for (const directory of ["apps/backend/src", "apps/judge/src", "packages/frontend/src"])
    for (const filename of productionFiles(path.join(repository, directory))) {
      const file = source(filename);
      function visit(node) {
        const expressions = [];
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          if (ts.isIdentifier(callee) && callee.text === "generateText") expressions.push(node.arguments[1], node.arguments[2]);
          else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "model")
            expressions.push(node.arguments[callee.expression.kind === ts.SyntaxKind.ThisKeyword ? 1 : 0]);
          else if (ts.isIdentifier(callee) && callee.text === "model") expressions.push(node.arguments[0]);
        }
        if (ts.isPropertyAssignment(node) && ["instructions", "systemPrompt", "system_prompt"].includes(node.name.text))
          expressions.push(node.initializer);
        for (const expression of expressions) {
          const texts = fragments(expression);
          if (texts.length) records.push({ filename: path.relative(repository, filename),
            line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, texts });
        }
        ts.forEachChild(node, visit);
      }
      visit(file);
    }
  return records;
}

test("all repository model instructions and transitive prompt fragments use English", () => {
  const records = promptRecords();
  assert(records.length >= 25, "Expected full model-call and backend-facts prompt coverage");
  assert(records.some(record => record.filename.endsWith("ai-source-search.ts")), "Source discovery prompts must be checked");
  assert(records.some(record => record.filename.endsWith("ai-tutorial-facts.ts")), "Injected tutorial instructions must be checked");
  const mixed = records.filter(record => record.texts.some(text => /\p{Script=Han}/u.test(text)));
  assert.deepEqual(mixed.map(record => `${record.filename}:${record.line}`), [], "Chinese instruction text remains in a model prompt");
});

test("English instructions retain Chinese and English outputs, original-language data and JSON editor fields", () => {
  const service = source(path.join(__dirname, "ai-workflow.service.ts"));
  const system = fragments(initializer(service, "SYSTEM")).join("");
  assert.match(system, /zh_CN content must be Chinese/);
  assert.match(system, /en_US content must be English/);
  assert.match(system, /Preserve the original language when extracting/);
  const importPrompt = promptRecords().flatMap(record => record.texts).find(text => text.startsWith("Extract this programming problem"));
  assert(importPrompt);
  for (const key of ["localizedContents", "locale", "description", "input", "output", "limitsAndHints", "judgeInfo", "fileIo", "fileIoEvidence"])
    assert(importPrompt.includes(`"${key}"`), `Original JSON field ${key} must remain intact`);
  assert.match(importPrompt, /Preserve original language and all real problem rules/);
  const tutorial = promptRecords().flatMap(record => record.texts).find(text => text.startsWith("Write an original, rigorous bilingual tutorial"));
  assert(tutorial.includes('"zh_CN"') && tutorial.includes('"en_US"'));
  const editor = fs.readFileSync(path.join(__dirname, "ai-editor-template.ts"), "utf8");
  assert(editor.includes('description: "题目描述"'));
  assert(editor.includes('limitsAndHints: "数据范围与提示"'));
});
