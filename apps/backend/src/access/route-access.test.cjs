/* AccessGuard names routes in its permission table by path. A route renamed in its controller would silently lose
   its check, so every path the table names must be a route that exists. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function controllerFiles(directory = root) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return controllerFiles(file);
    return entry.name.endsWith(".controller.ts") ? [file] : [];
  });
}

/** "area/action", lower-cased as the guard compares them. */
function routes() {
  const result = new Set();
  for (const file of controllerFiles()) {
    const source = fs.readFileSync(file, "utf8");
    const area = source.match(/@Controller\("([^"]*)"\)/)?.[1];
    if (area === undefined) continue;
    for (const [, action] of source.matchAll(/@(?:Get|Post)\("([^"]+)"\)/g))
      result.add(`${area}/${action}`.toLowerCase());
  }
  return result;
}

test("every route the access guard names exists", () => {
  const existing = routes();
  assert(existing.has("problem/getproblem") && existing.has("submission/submit"), "routes are found");
  const guard = fs.readFileSync(path.join(__dirname, "access.guard.ts"), "utf8");
  const named = [...guard.matchAll(/"([a-z]+\/[a-z]+)":\s*P\./g)].map(match => match[1]);
  // Problem data actions are named by action alone.
  const problemActions = guard.match(/area === "problem" &&\s*\[([^\]]+)\]\.includes\(action\)/)[1];
  named.push(...[...problemActions.matchAll(/"([a-z]+)"/g)].map(match => "problem/" + match[1]));
  named.push(
    ...[...guard.matchAll(/area === "problem" && action === "([a-z]+)"/g)].map(match => "problem/" + match[1])
  );
  assert(named.length >= 20, "the guard's routes are found");
  const missing = named.filter(route => !existing.has(route));
  assert.deepEqual(missing, [], "the access guard names routes that don't exist");
  // Areas checked as a whole must exist too.
  const areas = new Set([...existing].map(route => route.split("/")[0]));
  for (const [, area] of guard.matchAll(/area === "([a-z]+)"/g))
    assert(areas.has(area), `no controller for area ${area}`);
});
