const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const ts = require("typescript");

require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2019,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        esModuleInterop: true
      }
    }).outputText,
    filename
  );

const { ProblemTypeTraditionalService } = require("./types/traditional/problem-type.service.ts");
const { ProblemTypeInteractionService } = require("./types/interaction/problem-type.service.ts");
const { ProblemTypeCommunicationService } = require("./types/communication/problem-type.service.ts");

for (const [problemMemoryLimit, expectedMemory] of [
  [384, 384],
  [1024, 512]
]) {
  for (const problemTimeLimit of [160, 2000]) {
    const configService = { config: { resourceLimit: { problemMemoryLimit, problemTimeLimit } } };
    const interaction = new ProblemTypeInteractionService(configService);
    const services = {
      Traditional: new ProblemTypeTraditionalService(configService),
      Interaction: interaction,
      Communication: new ProblemTypeCommunicationService(interaction)
    };
    for (const [type, service] of Object.entries(services)) {
      test(`${type} memory default with maxima of ${problemMemoryLimit} MiB and ${problemTimeLimit} ms`, () => {
        assert.equal(service.getDefaultJudgeInfo().memoryLimit, expectedMemory);
      });
    }
  }
}
