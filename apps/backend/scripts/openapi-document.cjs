/*
 * Builds the backend's OpenAPI document from the compiled controllers (dist/, made by `nest build`) without a
 * database, Redis or configuration: controllers get inert stand-ins for their dependencies and are never called.
 * The frontend's typed client is generated from this document
 * (`node packages/frontend/scripts/generate-api.js --from-backend-build`), and
 * packages/frontend/test/api-contract.test.cjs checks that the committed client matches it.
 *
 * Usage: node apps/backend/scripts/openapi-document.cjs > openapi.json
 */
const path = require("path");

const dist = path.join(__dirname, "../dist");

/** A stand-in that tolerates any property access or call made while controllers are constructed. */
const inert = new Proxy(function () {}, {
  get(target, key) {
    if (key === "then") return undefined;
    if (key === Symbol.toPrimitive) return () => "";
    if (key === Symbol.iterator) return function* empty() {};
    return inert;
  },
  apply: () => inert,
  construct: () => inert
});

/**
 * Controllers in the order the server registers them, so the document lists paths in the same order. This follows
 * Nest's module scanner (@nestjs/core scanner.js, scanForModules): depth first, skipping only import definitions
 * already visited, and inserting each module the first time it is reached.
 */
function scanControllers(definition, visited = [], modules = new Map()) {
  const resolved = definition?.forwardRef ? definition.forwardRef() : definition;
  const moduleClass = resolved.module || resolved;
  // Dynamic modules (such as TypeOrmModule.forFeature) are distinct modules even when they share a class.
  const token = resolved.module ? resolved : moduleClass;
  if (!modules.has(token))
    modules.set(token, [...(Reflect.getMetadata("controllers", moduleClass) || []), ...(resolved.controllers || [])]);
  visited.push(definition);
  for (const imported of [...(Reflect.getMetadata("imports", moduleClass) || []), ...(resolved.imports || [])])
    if (!visited.includes(imported)) scanControllers(imported, visited, modules);
  return [...modules.values()].flat();
}

const ENHANCERS = ["__guards__", "__interceptors__", "__pipes__", "__exceptionFilters__"];

/** The providers a class needs: its constructor and property injections. */
function dependencyTokens(type) {
  const tokens = [...(Reflect.getMetadata("design:paramtypes", type) || [])];
  for (const { index, param } of Reflect.getMetadata("self:paramtypes", type) || [])
    tokens[index] = param?.forwardRef ? param.forwardRef() : param;
  for (const { type: property } of Reflect.getMetadata("self:properties_metadata", type) || [])
    tokens.push(property?.forwardRef ? property.forwardRef() : property);
  return tokens.filter(token => token !== undefined && token !== Object);
}

/** A controller's dependencies, and those of the guards, interceptors, pipes and filters on it or its routes. */
function controllerTokens(controller) {
  const targets = [
    controller,
    ...Object.getOwnPropertyNames(controller.prototype).map(name => controller.prototype[name])
  ];
  const enhancers = targets
    .flatMap(target => ENHANCERS.flatMap(key => Reflect.getMetadata(key, target) || []))
    .filter(enhancer => typeof enhancer === "function");
  return [...dependencyTokens(controller), ...enhancers.flatMap(dependencyTokens)];
}

async function buildOpenApiDocument() {
  // Controllers import the server's version from main.js, which would start the server: give them a stand-in.
  const Module = require("module");
  const main = new Module(path.join(dist, "main.js"));
  main.filename = main.id;
  main.loaded = true;
  main.exports = { appGitRepoInfo: {} };
  require.cache[main.id] = main;

  require(path.join(dist, "../node_modules/reflect-metadata"));
  const { Module: NestModule } = require(path.join(dist, "../node_modules/@nestjs/common"));
  const { NestFactory } = require(path.join(dist, "../node_modules/@nestjs/core"));
  const { SwaggerModule, DocumentBuilder } = require(path.join(dist, "../node_modules/@nestjs/swagger"));
  const { AppModule } = require(path.join(dist, "app.module"));
  const packageInfo = require(path.join(dist, "../package.json"));

  const controllers = scanControllers(AppModule);
  const tokens = new Set(controllers.flatMap(controllerTokens));
  class OpenApiDocumentModule {}
  NestModule({ controllers, providers: [...tokens].map(token => ({ provide: token, useValue: inert })) })(
    OpenApiDocumentModule
  );
  const app = await NestFactory.create(OpenApiDocumentModule, { logger: false, abortOnError: false });
  // Must match main.ts.
  app.setGlobalPrefix("api");
  const options = new DocumentBuilder()
    .setTitle("LLMOJ API")
    .setDescription(packageInfo.description)
    .setVersion(`v${packageInfo.version}`)
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, options);
  await app.close();
  // Exactly what the server sends at /docs-json (a RegExp `pattern`, for one, becomes `{}`).
  return JSON.parse(JSON.stringify(document));
}

module.exports = { buildOpenApiDocument };

if (require.main === module)
  buildOpenApiDocument().then(
    document => process.stdout.write(JSON.stringify(document)),
    error => {
      console.error(error);
      process.exit(1);
    }
  );
