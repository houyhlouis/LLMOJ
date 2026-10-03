/** Empty editor placeholders are retained in drafts, but are not statement sections. */
export function isVisibleProblemSection(
  section: { type: string; text?: string; sampleId?: number },
  samples: Array<{ inputData?: string; outputData?: string }> = []
): boolean {
  if (section.type === "Text") return !!section.text?.trim();
  const sample = samples[section.sampleId];
  return !!(sample && (sample.inputData?.trim() || sample.outputData?.trim()));
}
