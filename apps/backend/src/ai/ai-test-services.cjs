// Test harness (not a test itself): builds the AI services the way the AI module wires them.
//
// Tests written before the AI service was split gave AiService's constructor its dependencies and then stubbed its
// methods and fields. `aiServices(...)` takes the same dependencies and returns one object with that shape: reading or
// setting a method on it reaches the service that owns the method, and setting a dependency sets it on every service
// that holds it. So a stub such as `service.checkpoint = ...` replaces the checkpoint every service calls.
// `bareAiServices()` is the same without running any constructor, as `Object.create(AiService.prototype)` was.
//
// The TypeScript loader must be registered before this file is required.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { AI_EXECUTION_PROTOCOL_VERSION } = require("@libreoj/judge-protocol");
const { AiService } = require("./ai.service.ts");
const { AiConfigurationService } = require("./ai-configuration.service.ts");
const { AiJobCoordinator } = require("./ai-job-coordinator.service.ts");
const { AiArtifactPublisher } = require("./ai-artifact-publisher.service.ts");
const { AiWorkflowService } = require("./ai-workflow.service.ts");

const CLASSES = {
  facade: AiService,
  configuration: AiConfigurationService,
  coordinator: AiJobCoordinator,
  publisher: AiArtifactPublisher,
  workflow: AiWorkflowService
};

// Which services hold each dependency or piece of state
const FIELDS = {
  db: ["coordinator", "publisher", "workflow"],
  jobs: ["facade", "coordinator"],
  configurations: ["configuration"],
  key: ["configuration"],
  keyLoading: ["configuration"],
  privileges: ["coordinator", "publisher", "workflow"],
  problems: ["coordinator", "publisher", "workflow"],
  problemAccess: ["facade", "coordinator", "publisher"],
  problemFiles: ["publisher", "workflow"],
  problemTags: ["publisher", "workflow"],
  discussions: ["workflow"],
  files: ["facade", "publisher", "workflow"],
  usage: ["facade", "coordinator"],
  admission: ["facade", "coordinator"],
  policies: ["coordinator"],
  metricsService: ["coordinator"],
  aiAudit: ["coordinator"],
  execution: ["workflow"],
  metricWorkerErrors: ["coordinator"],
  workerErrorLoggedAt: ["coordinator"],
  timer: ["coordinator"],
  busy: ["coordinator"],
  stopped: ["coordinator"],
  activeRuns: ["coordinator"]
};
// A problem stub given as `problems` also stands for the services split out of ProblemService
const PROBLEM_PARTS = ["problemAccess", "problemFiles", "problemTags"];

const fileHash = filename => {
  const data = fs.readFileSync(filename);
  return { sha256: crypto.createHash("sha256").update(data).digest("hex"), size: data.length };
};

/**
 * A stubbed `runSandbox` reports with its result what a runner of judge protocol version 8 does (review Part III,
 * W03), unless it reports it itself: how the result was made, the operation it is, and its cases, from the files it
 * wrote (1.in, 1.out, 2.in, …).
 */
function asCurrentRunner(run) {
  return async (...args) => {
    const result = await run(...args);
    if (!result || typeof result !== "object") return result;
    const now = new Date().toISOString();
    const reported = {
      operation: { key: "0".repeat(64), origin: "local", result: "new" },
      execution: {
        contract: AI_EXECUTION_PROTOCOL_VERSION,
        attemptId: crypto.randomUUID(),
        runtime: { judgeProgram: "0".repeat(64), sandboxImage: "test", arch: "x64" },
        startedAt: now,
        finishedAt: now,
        reuse: { builds: 0, inputs: 0 }
      }
    };
    if (result.corpus === undefined && typeof result.directory === "string" && Array.isArray(result.files)) {
      const corpus = [];
      for (let index = 1; result.files.includes(`${index}.in`) && result.files.includes(`${index}.out`); index++)
        corpus.push({
          index,
          subtask: 1,
          scenarioIndex: index,
          origin: "generated",
          input: fileHash(path.join(result.directory, `${index}.in`)),
          output: fileHash(path.join(result.directory, `${index}.out`))
        });
      reported.corpus = corpus;
    }
    return { ...reported, ...result };
  };
}

function methodOwners(name) {
  return Object.keys(CLASSES).filter(
    key => name !== "constructor" && Object.prototype.hasOwnProperty.call(CLASSES[key].prototype, name)
  );
}

function wire(services) {
  const { facade, configuration, coordinator, publisher, workflow } = services;
  Object.assign(coordinator, { configuration, workflow });
  Object.assign(publisher, { coordinator });
  Object.assign(workflow, { configuration, coordinator, publisher });
  Object.assign(facade, { configuration, coordinator, workflow });
}

function combined(services, explicitParts = new Set()) {
  const own = services.facade;
  return new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name === "symbol") return undefined;
        if (name === "services") return services;
        if (FIELDS[name]) return services[FIELDS[name][0]][name];
        const owners = methodOwners(name);
        if (owners.length > 1)
          return async (...args) => {
            for (const key of owners) await services[key][name](...args);
          };
        if (owners.length === 1) {
          const owner = services[owners[0]];
          const value = owner[name];
          return typeof value === "function" ? value.bind(owner) : value;
        }
        return own[name];
      },
      set(_target, name, value) {
        if (FIELDS[name]) {
          for (const key of FIELDS[name]) services[key][name] = value;
          if (PROBLEM_PARTS.includes(name)) explicitParts.add(name);
          if (name === "problems")
            for (const part of PROBLEM_PARTS)
              if (!explicitParts.has(part)) for (const key of FIELDS[part]) services[key][part] = value;
          return true;
        }
        const owners = methodOwners(name);
        const stub = name === "runSandbox" && typeof value === "function" ? asCurrentRunner(value) : value;
        if (owners.length) for (const key of owners) services[key][name] = stub;
        else own[name] = value;
        return true;
      },
      has(_target, name) {
        return !!FIELDS[name] || methodOwners(name).length > 0 || name in own;
      }
    }
  );
}

/**
 * The AI services from the dependencies of the old AiService constructor. `parts` gives the services split out of
 * ProblemService when `problems` is a real ProblemService: { problemAccess, problemFiles, problemTags }.
 */
function aiServices(db, configurations, jobs, privileges, problems, discussions, files, parts = {}) {
  const problemAccess = parts.problemAccess ?? problems;
  const problemFiles = parts.problemFiles ?? problems;
  const problemTags = parts.problemTags ?? problems;
  const configuration = new AiConfigurationService(configurations);
  const coordinator = new AiJobCoordinator(db, jobs, privileges, problems, problemAccess, configuration);
  const publisher = new AiArtifactPublisher(
    db,
    privileges,
    problems,
    problemAccess,
    problemFiles,
    problemTags,
    files,
    coordinator
  );
  const workflow = new AiWorkflowService(
    db,
    privileges,
    problems,
    problemFiles,
    problemTags,
    discussions,
    files,
    configuration,
    coordinator,
    publisher
  );
  const facade = new AiService(jobs, problemAccess, files, configuration, coordinator, workflow);
  return combined(
    { facade, configuration, coordinator, publisher, workflow },
    new Set(PROBLEM_PARTS.filter(part => parts[part]))
  );
}

/** The AI services without running their constructors, wired to each other. */
function bareAiServices() {
  const services = Object.fromEntries(Object.entries(CLASSES).map(([key, Class]) => [key, Object.create(Class.prototype)]));
  wire(services);
  return combined(services);
}

module.exports = { aiServices, bareAiServices };
