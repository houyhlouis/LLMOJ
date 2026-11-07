import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";

import { generateText as providerText } from "./ai-provider";
import { withAiPurpose } from "./ai-runtime";
import { purposeOfStep } from "./ai-session";
import { startJobStage, workflowState, type AiStageAttempt } from "./ai-workflow-state";
import type { AiJobEntity } from "./ai.entity";
import type { AiConfiguration, LlmConfiguration } from "./ai.types";
import { dispatch, type AiModelOutput } from "./ai-model-dispatch";

export type AiModelPurpose = "reasoning" | "schema_repair" | "metadata" | "compiler_fix";
export type AiModelPolicies = Partial<
  Record<AiModelPurpose, { model: string; reasoning?: string; maxTokens?: number }>
>;
const modelStages = new AsyncLocalStorage<string>();
export const withModelStage = <T>(stage: string, work: () => Promise<T>) => modelStages.run(stage, work);
const jobs = new AsyncLocalStorage<{
  job: AiJobEntity;
  config: AiConfiguration;
  persist: () => Promise<void>;
  writes: Promise<unknown>;
}>();
export const withWorkflowModels = <T>(
  job: AiJobEntity,
  config: AiConfiguration,
  persist: () => Promise<void>,
  work: () => Promise<T>
) => jobs.run({ job, config, persist, writes: Promise.resolve() }, work);

export function modelPurpose(stage: string): AiModelPurpose {
  if (stage.includes("field-repair")) return "schema_repair";
  if (stage.includes("compiler-fix")) return "compiler_fix";
  if (/^(?:tags|translate|source)(?:\.|$)/.test(stage)) return "metadata";
  return "reasoning";
}
/** A single writer serializes dispatch/completion checkpoints, including concurrent calls. */
export async function workflowText(
  config: LlmConfiguration,
  system: string,
  prompt: string,
  image?: string,
  output?: AiModelOutput
): Promise<string> {
  const context = jobs.getStore();
  if (!context) return await providerText(config, system, prompt, image);
  const { job } = context;
  const dispatchedStage = modelStages.getStore() || job.step;
  const purpose = modelPurpose(dispatchedStage);
  const selected = { ...config, ...context.config.modelPolicies?.[purpose] };
  const state = workflowState(job.state, job.input?.workflow);
  let stage: AiStageAttempt;
  let resumption: NonNullable<AiStageAttempt["resumptions"]>[number];
  const write = () => {
    context.writes = context.writes.then(context.persist);
    return context.writes;
  };
  const identity = {
    stageId: randomUUID(),
    generationId: randomUUID(),
    requiredGenerationId: dispatchedStage.includes("field-repair")
      ? job.state.planRepair?.repairGenerationId
      : undefined,
    output,
    bindIdentity: async (saved: import("./ai-runtime").AiResponseCheckpoint) => {
      if (!saved.stageId) return; // Historical handles remain unlinked.
      stage = state.stages.find(entry => entry.id === saved.stageId);
      if (!stage) {
        stage = startJobStage(job, dispatchedStage, ["accepted-plan", "unaffected-artifacts"], []);
        stage.id = saved.stageId;
        stage.generationId = saved.generationId;
        stage.policy = purpose;
        stage.model = selected.model;
        stage.promptBytes = Buffer.byteLength(system) + Buffer.byteLength(prompt);
      } else {
        resumption = { attempt: job.attempt || 0, startedAt: new Date().toISOString() };
        (stage.resumptions ||= []).push(resumption);
        stage.status = "running";
        delete stage.finishedAt;
      }
      if (dispatchedStage.includes("field-repair") && job.state.planRepair) {
        job.state.planRepair.generationId = saved.generationId;
        job.state.planRepair.repairGenerationId = saved.generationId;
      }
      await write();
    }
  };
  const started = Date.now();
  try {
    const result = await dispatch.run(identity, () =>
      withAiPurpose(purposeOfStep(dispatchedStage), () => providerText(selected, system, prompt, image))
    );
    if (stage) {
      stage.status = "completed";
      stage.outputBytes = Buffer.byteLength(result);
    }
    return result;
  } catch (error) {
    if (stage) stage.status = "failed";
    throw error;
  } finally {
    if (stage) {
      stage.finishedAt = new Date().toISOString();
      stage.durationMs = (stage.durationMs || 0) + Date.now() - started;
      if (resumption) Object.assign(resumption, { endedAt: stage.finishedAt, status: stage.status });
      await write();
    }
  }
}

export async function coordinateModelResult<T>(work: () => Promise<T>): Promise<T> {
  const context = jobs.getStore();
  if (!context) return await work();
  const result = context.writes.then(work);
  context.writes = result;
  return await result;
}

export async function workflowSearch<T>(query: string, work: () => Promise<T>): Promise<T> {
  const context = jobs.getStore();
  if (!context) return await work();
  const stage = startJobStage(context.job, context.job.step, ["verified-search-documents"], []);
  stage.policy = "search";
  stage.promptBytes = Buffer.byteLength(query);
  await coordinateModelResult(context.persist);
  try {
    const result = await dispatch.run({ stageId: stage.id, generationId: stage.id }, () =>
      withAiPurpose("source", work)
    );
    stage.status = "completed";
    return result;
  } catch (error) {
    stage.status = "failed";
    throw error;
  } finally {
    stage.finishedAt = new Date().toISOString();
    stage.durationMs = Date.now() - Date.parse(stage.startedAt);
    await coordinateModelResult(context.persist);
  }
}

/** Keep all statements, bounds, I/O and samples. Omit private data and unrelated judge filenames/metadata. */
export function mathematicalContext(snapshot: {
  statements: unknown;
  samples: unknown;
  judgeInfo: Record<string, unknown>;
}) {
  return {
    statements: snapshot.statements,
    samples: snapshot.samples,
    limits: {
      timeLimit: snapshot.judgeInfo?.timeLimit,
      memoryLimit: snapshot.judgeInfo?.memoryLimit,
      fileIo: snapshot.judgeInfo?.fileIo
    }
  };
}
