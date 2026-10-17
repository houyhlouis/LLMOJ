// Usage: node scripts/generate-api.js [<docs-json URL> | --from-backend-build] [--out <directory>]
// --from-backend-build reads the API from the compiled backend (apps/backend/dist) instead of a running server.
const path = require("path");
const fetch = require("node-fetch");
const dtsgenerator = require("dtsgenerator").default;
const fs = require("fs-extra");
const prettier = require("prettier");

const apiUrl =
  process.argv.filter(arg => arg.toLowerCase().startsWith("http://") || arg.toLowerCase().startsWith("https://"))[0] ||
  "http://127.0.0.1:2002/docs-json";
const fromBackendBuild = process.argv.includes("--from-backend-build");
const outIndex = process.argv.indexOf("--out");
const defaultOutput = path.join(__dirname, "../src/api-generated");
const output = outIndex > 0 ? path.resolve(process.argv[outIndex + 1]) : defaultOutput;

async function readApi() {
  if (fromBackendBuild)
    return await require("../../../apps/backend/scripts/openapi-document.cjs").buildOpenApiDocument();
  return await (await fetch(apiUrl)).json();
}

// Formatted as the repository's files are, so the output can be compared with the committed client.
async function write(file, code) {
  const options = await prettier.resolveConfig(path.join(defaultOutput, "index.ts"));
  await fs.writeFile(path.join(output, file), prettier.format(code, { ...options, parser: "typescript" }));
}

const skipTags = ["App", "CORS"];
const namespaceName = "ApiTypes";
const generatedMessage = "// This file is generated automatically, do NOT modify it.\n\n";

function getSchemaName(schema) {
  return schema["$ref"] && schema["$ref"].split("/").pop();
}

function getRequestBodySchemaName(requestBody) {
  return requestBody && getSchemaName(requestBody.content["application/json"].schema);
}

function getResponseSchemaName(responses) {
  const response = Object.values(responses)[0];
  return response.content && getSchemaName(response.content["application/json"].schema);
}

function normalizeModuleName(moduleName, forFilename) {
  if (forFilename) return moduleName.split(" ").join("-").toLowerCase();
  else return moduleName.split(" ").join("");
}

(async () => {
  const api = await readApi();
  await fs.remove(output);
  await fs.ensureDir(path.join(output, "modules"));

  // Generate types file with dtsgenerator
  const typesFile = await dtsgenerator({
    contents: [api],
    namespaceName
  });
  await write("types.d.ts", generatedMessage + typesFile);

  // Parse OpenAPI definitions
  const tags = {};
  for (const path in api.paths) {
    const operation = api.paths[path];
    const tag = (operation.get || operation.post).tags?.[0];

    if (!tag || skipTags.includes(tag)) continue;

    if (!tags[tag])
      tags[tag] = {
        schemas: new Set(),
        operations: {}
      };

    if (operation.get) {
      const response = getResponseSchemaName(operation.get.responses);
      tags[tag].operations[operation.get.operationId] = {
        type: "get",
        path,
        parameters:
          operation.get.parameters && operation.get.parameters.map(({ name, required }) => ({ name, required })),
        response
      };

      if (response) tags[tag].schemas.add(response);
    } else {
      const body = getRequestBodySchemaName(operation.post.requestBody),
        response = getResponseSchemaName(operation.post.responses);
      tags[tag].operations[operation.post.operationId] = {
        type: "post",
        path,
        body,
        response,
        captchaAction: operation.post["x-captcha-action"] ?? null,
        proofOfWorkAction: operation.post["x-proof-of-work-action"] ?? null
      };

      if (body) tags[tag].schemas.add(body);
      if (response) tags[tag].schemas.add(response);
    }
  }

  // Generate ts files
  for (const moduleName in tags) {
    const types = Array.from(tags[moduleName].schemas);
    let code = "";

    code += generatedMessage;
    code += '/// <reference path="../types.d.ts" />\n\n';

    code += 'import { createGetApi, createPostApi } from "@/api";\n\n';

    for (const operationName in tags[moduleName].operations) {
      const operation = tags[moduleName].operations[operationName];
      const path = operation.path.replace("/api/", "");
      const rawFunctionName = operationName.split("_").pop();
      const functionName = [
        "delete",
        "export",
        "import",
        "default",
        "new",
        "class",
        "return",
        "switch",
        "case",
        "throw",
        "try",
        "catch",
        "finally",
        "var",
        "let",
        "const",
        "function",
        "if",
        "else",
        "for",
        "while",
        "do",
        "break",
        "continue",
        "extends",
        "super",
        "this",
        "in",
        "instanceof",
        "typeof",
        "void",
        "with",
        "yield",
        "await",
        "enum"
      ].includes(rawFunctionName)
        ? `${rawFunctionName}_`
        : rawFunctionName;

      if (operation.type === "post") {
        const bodyType = operation.body ? `ApiTypes.${operation.body}` : "void",
          responseType = operation.response ? `ApiTypes.${operation.response}` : "void";
        const options = {};
        if (operation.captchaAction !== null) options.captchaAction = operation.captchaAction;
        if (operation.proofOfWorkAction !== null) options.proofOfWorkAction = operation.proofOfWorkAction;

        const typeParameters = [bodyType, responseType];
        const optionEntries = Object.entries(options);
        if (optionEntries.length > 0) {
          typeParameters.push(
            `{ ${optionEntries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("; ")} }`
          );
        }
        code += `export const ${functionName} = createPostApi<${typeParameters.join(", ")}>(${JSON.stringify(
          path
        )}, ${JSON.stringify(options)});\n`;
      } else {
        const parameterTypes =
            operation.parameters &&
            operation.parameters.map(({ name, required }) => `${name}${required ? "" : "?"}: string`).join(", "),
          parameterType = parameterTypes ? `{ ${parameterTypes} }` : "void",
          responseType = operation.response ? `ApiTypes.${operation.response}` : "void";
        code += `export const ${functionName} = createGetApi<${parameterType}, ${responseType}>(${JSON.stringify(
          path
        )});\n`;
      }
    }

    await write(`modules/${normalizeModuleName(moduleName, true)}.ts`, code);
  }

  // Generate index file
  let code = "";

  code += generatedMessage;
  for (const moduleName in tags) {
    code += `import * as Imported${normalizeModuleName(moduleName)}Api from "./modules/${normalizeModuleName(
      moduleName,
      true
    )}";\n`;
  }
  code += "\n";
  for (const moduleName in tags) {
    const importedModule = normalizeModuleName(moduleName);
    const exportModule = importedModule.charAt(0).toLowerCase() + importedModule.slice(1);
    code += `export const ${exportModule} = Imported${importedModule}Api;\n`;
  }

  await write("index.ts", code);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
