import type { AiCorpusPolicy, AiWorkflowState } from "./ai-workflow-state";

/** A policy-filtered description: no private names, sample fingerprints or bytes. */
export function corpusContext(state: AiWorkflowState, policy: AiCorpusPolicy = "private") {
  return {
    publicExamples: state.corpus.filter(c => c.class === "public_example").length,
    authorValidation:
      "Additional private validation fixtures may exist and are tested locally. Never assume visible examples are the full baseline.",
    ...(policy === "private"
      ? {}
      : {
          validationSummary: state.corpus
            .filter(c => c.class === "author_validation")
            .map(c => ({ inputBytes: c.inputBytes, outputBytes: c.outputBytes })),
          exposedDefects: state.candidates
            .filter(c => c.role === "baseline")
            .map(c => ({ id: c.id, reason: "The existing baseline already exposes this defect." }))
        })
  };
}
