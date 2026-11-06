/*
 * Tutorial code tied to the reference solution (review Part III, H08/W06). A job's AI tutorial shows a C++
 * implementation. Whether that code passed the official samples, was rejected by one, is the reference solution the
 * job's published test data was made and checked with, or was set aside for another program, is kept with the job and
 * shown to the tutorial's owner and readers. It says what the code passed: never that the proof is verified.
 */
import { createHash } from "crypto";

import { normalizeAiMarkdown } from "./ai-content";
import { tutorialCppCandidates } from "./ai-reference";

export type AiTutorialLocale = "zh_CN" | "en_US";

/**
 * What a tutorial's code is now:
 * - "no-code": the tutorial has no C++ implementation the job could run;
 * - "unchecked": not run yet (or the job doesn't make test data);
 * - "passed-samples": it passed the official samples, and no test data was published yet;
 * - "rejected": it failed an official sample (see the job's failure details);
 * - "qualified": it is the reference solution the published test data was made and checked with;
 * - "superseded": the published test data was made with another reference solution (a model-written one, or a repaired
 *   one), so the tutorial's code wasn't checked as the reference.
 */
export type AiTutorialCodeStatus = "no-code" | "unchecked" | "passed-samples" | "rejected" | "qualified" | "superseded";

/** A published tutorial of the job, and the code it shows. */
export interface AiTutorialBinding {
  discussionId: number;
  locale: AiTutorialLocale;
  // SHA-256 of its first C++ implementation, as the reference solution check reads it; null if it has none
  sha256: string | null;
  at: string;
  // Its code was replaced by the reference solution's (see the correction), and what it was before
  corrected?: { at: string; from: string | null };
}

/** A tutorial implementation the job ran on the official samples. */
export interface AiTutorialCheck {
  result: "passed" | "rejected";
  samples: number;
  // A rejection's failure: its kind (e.g. "wrong_answer", "compile_error"), what was checked (e.g. "sample 2") and its
  // message; and the failure kept with its sample, outputs and diagnostics
  kind?: string;
  subject?: string;
  reason?: string;
  observationId?: string;
  discussionId?: number;
  at: string;
}

export const sha256Of = (text: string) => createHash("sha256").update(text).digest("hex");

/** The code a tutorial shows, as the job's reference solution check would read it from its published content. */
export function tutorialCodeSha(content: unknown, grader: boolean): string | null {
  return tutorialCppCandidates(content, grader)[0]?.sha256 || null;
}

/**
 * A tutorial's status from the job's checks and the reference solution its published test data was made with
 * (`published`: its SHA-256, or null while no test data is published).
 */
export function tutorialCodeStatus(
  binding: Pick<AiTutorialBinding, "sha256">,
  checks: Record<string, AiTutorialCheck>,
  published: string | null
): AiTutorialCodeStatus {
  if (!binding.sha256) return "no-code";
  const check = checks?.[binding.sha256];
  if (check?.result === "rejected") return "rejected";
  if (published) return published === binding.sha256 ? "qualified" : "superseded";
  return check?.result === "passed" ? "passed-samples" : "unchecked";
}

/** The reference solution the job's published test data was made with, if it published any. */
export function publishedReference(state: Record<string, unknown>): string | null {
  if (!state.generated || typeof state.stdCode !== "string") return null;
  return sha256Of(state.stdCode);
}

export interface AiTutorialView {
  discussionId: number;
  locale: AiTutorialLocale;
  status: AiTutorialCodeStatus;
  samplesPassed?: number;
  // Why a rejected implementation was rejected, and its kept failure
  kind?: string;
  subject?: string;
  reason?: string;
  observationId?: string;
  corrected?: string;
}

/**
 * The job's tutorials and the code each shows. A job from before they were kept has them from its tutorials' text as
 * it published it.
 */
export function tutorialBindingsOf(state: Record<string, unknown>): AiTutorialBinding[] {
  if (Array.isArray(state.tutorialBindings)) return state.tutorialBindings as AiTutorialBinding[];
  const ids = (state.discussionIds as Partial<Record<AiTutorialLocale, number>>) || {};
  const contents = (state.tutorialContents as Partial<Record<AiTutorialLocale, string>>) || {};
  return (["zh_CN", "en_US"] as const)
    .filter(locale => ids[locale] && typeof contents[locale] === "string")
    .map(locale => ({
      discussionId: ids[locale],
      locale,
      sha256: tutorialCodeSha(normalizeAiMarkdown(contents[locale]), !!state.graderCode),
      at: ""
    }));
}

/** The job's tutorials and their status, as its owner sees them. */
export function tutorialViews(state: Record<string, unknown>): AiTutorialView[] {
  const bindings = tutorialBindingsOf(state);
  const checks = (state.tutorialChecks as Record<string, AiTutorialCheck>) || {};
  const published = publishedReference(state);
  return bindings.map(binding => {
    const check = binding.sha256 ? checks[binding.sha256] : undefined;
    return {
      discussionId: binding.discussionId,
      locale: binding.locale,
      status: tutorialCodeStatus(binding, checks, published),
      ...(check ? { samplesPassed: check.samples } : {}),
      ...(check?.result === "rejected"
        ? Object.fromEntries(
            (["kind", "subject", "reason", "observationId"] as const)
              .filter(key => check[key])
              .map(key => [key, check[key]])
          )
        : {}),
      ...(binding.corrected ? { corrected: binding.corrected.at } : {})
    };
  });
}

/**
 * Why the job's tutorials can't have their code replaced by its reference solution now, or null if they can: a
 * tutorial's code was rejected or set aside, the job published test data with a reference solution that passed every
 * check, and that solution reads and writes as the problem's submissions must (`fileIo`: the problem's named files).
 */
export function tutorialCorrectionRefusal(
  state: Record<string, unknown>,
  fileIo: { inputFilename: string; outputFilename: string } | null
): "NOTHING_TO_CORRECT" | "NO_REFERENCE" | "FILE_IO" | null {
  if (!tutorialViews(state).some(view => ["rejected", "superseded"].includes(view.status))) return "NOTHING_TO_CORRECT";
  if (!publishedReference(state)) return "NO_REFERENCE";
  // A model-written reference solution reads stdin; it isn't a submission of a problem judged with named files
  const stdFileIo = state.stdFileIo as { inputFilename: string; outputFilename: string } | null;
  if (
    fileIo &&
    (stdFileIo?.inputFilename !== fileIo.inputFilename || stdFileIo?.outputFilename !== fileIo.outputFilename)
  )
    return "FILE_IO";
  return null;
}

// Where the model puts the implementation in a corrected tutorial; the job puts the reference solution there itself
export const AI_TUTORIAL_CODE_PLACEHOLDER = "<!-- REFERENCE SOLUTION -->";

/**
 * A corrected tutorial's content: the model's text with the placeholder replaced by exactly the reference solution.
 * Null unless the placeholder is there once and the result shows that code and no other implementation.
 */
export function correctedTutorial(text: unknown, reference: string, grader: boolean): string | null {
  if (typeof text !== "string" || text.length > 500000) return null;
  const parts = text.split(AI_TUTORIAL_CODE_PLACEHOLDER);
  if (parts.length !== 2) return null;
  const fence = reference.includes("```") ? "~~~~" : "```";
  const content = `${parts[0]}${fence}cpp\n${reference.trim()}\n${fence}${parts[1]}`;
  const candidates = tutorialCppCandidates(content, grader);
  return candidates.length === 1 && candidates[0].sha256 === sha256Of(reference.trim()) ? content : null;
}
