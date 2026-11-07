export const PLAN_LIMITS = Object.freeze({
  text: 4000,
  reason: 2000,
  id: 48,
  algorithms: [2, 4],
  targets: [1, 4],
  // Issues kept and reported for one proposal
  issues: 40,
  // A rejected proposal's text kept with the job, privately (its owner's job), when it's at most this large
  candidateBytes: 64 * 1024
});

const string = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const object = <T extends Record<string, unknown>>(properties: T) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties
});
/** Runtime constraints, prompt instructions, provider shape and fixtures share these bounds. */
export function qualityPlanSchema(subtasks: { id: number }[]) {
  return object({
    version: { type: "integer", const: 1 },
    correctAlgorithms: {
      type: "array",
      minItems: PLAN_LIMITS.algorithms[0],
      maxItems: PLAN_LIMITS.algorithms[1],
      items: string(PLAN_LIMITS.text)
    },
    oracleMethod: string(PLAN_LIMITS.text),
    smallInputStrategy: string(PLAN_LIMITS.text),
    targets: {
      type: "array",
      minItems: PLAN_LIMITS.targets[0],
      maxItems: PLAN_LIMITS.targets[1],
      items: object({
        id: { ...string(PLAN_LIMITS.id), pattern: "^[a-z][a-z0-9_-]*$" },
        kind: { type: "string", enum: ["wrong", "slow"] },
        algorithm: string(PLAN_LIMITS.text),
        reason: string(PLAN_LIMITS.reason),
        subtasks: { type: "array", minItems: 1, items: { type: "integer", enum: subtasks.map(s => s.id) } },
        construction: string(PLAN_LIMITS.text)
      })
    }
  });
}
