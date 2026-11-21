import { AI_ACTIONS, AI_JOB_STATUSES, type AiJobEntity } from "./ai.entity";

/** The shared job identity in both AI diagnostics and site administrator bundles. */
export function diagnosticJobIdentity(job: Pick<AiJobEntity, "id" | "revision" | "action" | "status">, id = job.id) {
  return {
    id,
    revision: job.revision,
    action: AI_ACTIONS.includes(job.action) ? job.action : null,
    status: AI_JOB_STATUSES.includes(job.status) ? job.status : null
  };
}

/** Export is an allowlisted metadata projection; never serialize a job/configuration entity. */
export const AI_EXPORT_VERSION = 1;
export function redactDiagnostic(value: unknown, depth = 0, field = ""): unknown {
  if (depth > 12) return { omitted: "depth_limit" };
  if (typeof value === "string") {
    const text = value
      .replace(/(?:Bearer\s+|sk[-_])[A-Za-z0-9_.-]+/gi, "[redacted]")
      .replace(/((?:api[_-]?key|password|secret|session|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
      .replace(/https?:\/\/[^\s"<>]+/g, "[url omitted]");
    return text.length > 4096 ? { text: text.slice(0, 4096), truncated: true } : text;
  }
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value))
    return {
      items: value.slice(0, 1000).map(v => redactDiagnostic(v, depth + 1, field)),
      omitted: Math.max(0, value.length - 1000)
    };
  if (typeof value !== "object") return null;
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    if (
      key === "code" &&
      ["attention", "blockingReason", "searchDiagnostics"].includes(field) &&
      typeof child === "string" &&
      /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(child)
    ) {
      output[key] = child;
      continue;
    }
    if (
      (!["errorCode", "providerCode"].includes(key) &&
        /(?:Code|Source|InputData|OutputData|SampleInput|SampleOutput|ReasoningText|ThinkingText|Password|Secret|ApiKey|Cookie|Authorization)$/i.test(
          key
        )) ||
      /^(?:apiKey|key|password|secret|encrypted|session|authorization|cookie|prompt|instructions|reasoning|thinking|input|output|code|source|diff|markdown|image|responseId|requestHash|bindingHash|accountBinding)$/i.test(
        key
      )
    )
      output[key] =
        (key === "input" || key === "output") &&
        child &&
        typeof child === "object" &&
        typeof child.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(child.sha256) &&
        typeof child.size === "number"
          ? { sha256: child.sha256, size: child.size }
          : { omitted: "private_content" };
    else output[key] = redactDiagnostic(child, depth + 1, key);
  }
  if (Object.keys(value).length > 100) output.omittedFields = Object.keys(value).length - 100;
  return output;
}
export function boundedDiagnosticExport(sections: Record<string, unknown>, maximumBytes = 2 * 1024 * 1024) {
  const result: Record<string, unknown> = {
    exportVersion: AI_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    excluded: [
      "credentials",
      "session secrets",
      "hidden input/output bytes",
      "raw model reasoning",
      "source bodies",
      "protocol streams",
      "unrelated users"
    ]
  };
  let bytes = Buffer.byteLength(JSON.stringify(result));
  const markers = Object.keys(sections).reduce((sum, name) => sum + Buffer.byteLength(name) + 96, 0);
  for (const [name, section] of Object.entries(sections)) {
    const safe = section === undefined ? { missing: true } : redactDiagnostic(section);
    const size = Buffer.byteLength(JSON.stringify(safe));
    if (bytes + size + name.length + 10 + markers > maximumBytes)
      result[name] = { truncated: true, reason: "export_byte_limit" };
    else {
      result[name] = safe;
      bytes += size + name.length + 10;
    }
  }
  return result;
}

/** Only plan-schema fields are eligible for explicit proposal export; arbitrary rejected JSON is not a data export. */
export function diagnosticPlanCandidate(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { unexported: "invalid_proposal_shape" };
  const candidate = value as Record<string, unknown>;
  const scalar = (item: unknown) =>
    item == null || ["string", "number", "boolean"].includes(typeof item)
      ? item
      : { unexported: "invalid_field_shape" };
  const fields = ["version", "correctAlgorithms", "oracleMethod", "smallInputStrategy", "targets"];
  const result: Record<string, unknown> = {
    omittedFields: Object.keys(candidate).filter(key => !fields.includes(key)).length
  };
  for (const key of fields) {
    if (!(key in candidate)) continue;
    const item = candidate[key];
    if (key === "correctAlgorithms" && Array.isArray(item)) result[key] = item.slice(0, 100).map(scalar);
    else if (key === "targets" && Array.isArray(item))
      result[key] = item.slice(0, 100).map(target => {
        if (!target || typeof target !== "object" || Array.isArray(target))
          return { unexported: "invalid_target_shape" };
        const names = ["id", "kind", "algorithm", "reason", "subtasks", "construction"];
        return {
          ...Object.fromEntries(
            names
              .filter(name => name in target)
              .map(name => [
                name,
                name === "subtasks" && Array.isArray(target[name])
                  ? target[name].slice(0, 1000).map(scalar)
                  : scalar(target[name])
              ])
          ),
          omittedFields: Object.keys(target).filter(name => !names.includes(name)).length
        };
      });
    else result[key] = scalar(item);
    if (Array.isArray(item) && item.length > 100 && ["targets", "correctAlgorithms"].includes(key))
      result[`${key}Omitted`] = item.length - 100;
  }
  return result;
}
