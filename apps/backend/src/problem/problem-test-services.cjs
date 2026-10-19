// Test harness (not a test itself): the services split out of ProblemService, for tests written against the single
// ProblemService of old.
//
// `bareProblemServices()` builds ProblemService, ProblemAccessService, ProblemFileService, ProblemTagService and
// ProblemLockService without running their constructors, as `Object.create(ProblemService.prototype)` did, wires them
// to each other, and returns one object: reading or setting a method on it reaches the service that owns the method,
// and any other property (a dependency such as `connection` or `configService`) is set on all of them. So a stub such
// as `problems.getProblemFiles = ...` replaces what every problem service calls, and the object can stand in for any
// of the services where another service or test expects one.
//
// The TypeScript loader must be registered before this file is required.
const { ProblemService } = require("./problem.service.ts");
const { ProblemAccessService } = require("./problem-access.service.ts");
const { ProblemFileService } = require("./problem-file.service.ts");
const { ProblemTagService } = require("./problem-tag.service.ts");
const { ProblemLockService } = require("./problem-lock.service.ts");

const CLASSES = {
  problemService: ProblemService,
  problemAccess: ProblemAccessService,
  problemFiles: ProblemFileService,
  problemTags: ProblemTagService,
  problemLocks: ProblemLockService
};

function bareProblemServices() {
  const services = Object.fromEntries(
    Object.entries(CLASSES).map(([key, Class]) => [key, Object.create(Class.prototype)])
  );
  const { problemService, problemAccess, problemFiles, problemTags, problemLocks } = services;
  Object.assign(problemService, { problemAccess, problemFiles, problemTags, problemLocks });
  Object.assign(problemFiles, { problemAccess, problemLocks });
  const owner = name =>
    name !== "constructor" &&
    Object.keys(CLASSES).find(key => Object.prototype.hasOwnProperty.call(CLASSES[key].prototype, name));
  return new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name === "symbol") return undefined;
        if (name === "services") return services;
        const key = owner(name);
        if (key) {
          const service = services[key];
          return typeof service[name] === "function" ? service[name].bind(service) : service[name];
        }
        const holder = Object.values(services).find(service => name in service);
        return holder?.[name];
      },
      set(_target, name, value) {
        const key = owner(name);
        if (key) services[key][name] = value;
        else for (const service of Object.values(services)) service[name] = value;
        return true;
      },
      has(_target, name) {
        return !!owner(name) || Object.values(services).some(service => name in service);
      }
    }
  );
}

module.exports = { bareProblemServices };
