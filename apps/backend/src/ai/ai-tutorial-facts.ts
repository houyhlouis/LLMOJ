/** Facts supplied by the backend, not inferred from a matching search result. */
export function aiTutorialFacts(
  judgeInfo: { subtasks?: Array<{ points?: number; scoringType?: string; testcases?: unknown[] }> },
  willGenerateData: boolean,
  source: { url?: string; title?: string; searchEvidence?: string }
) {
  const subtasks = (judgeInfo.subtasks || []).map(group => ({
    points: group.points,
    scoringType: group.scoringType,
    caseCount: group.testcases?.length || 0
  }));
  const partialScoring =
    subtasks.some(group => group.scoringType === "Sum" && group.caseCount > 1) ||
    subtasks.filter(group => group.points > 0 && group.caseCount > 0).length > 1;
  return {
    scoring: {
      currentSubtasks: subtasks,
      currentPartialScoring: partialScoring ? "possible" : "not established",
      futureDataGeneration: willGenerateData,
      instructions: willGenerateData
        ? "This tutorial precedes data generation. Current settings may be replaced. Final subtask allocation and case count are not yet verified; the generator publishes Sum scoring. Never claim there are no subtasks or no partial scores. Explain the full-score algorithm and defer final scoring details to the active judging configuration."
        : "Describe only the supplied active judging facts. Sum awards case-by-case points; failing some cases may still earn points. Missing subtasks are not evidence of all-or-nothing scoring. Do not invent scoring rules."
    },
    source: {
      relatedReferenceUrl: source.url || null,
      relatedReferenceTitle: source.title || null,
      searchEvidence: source.searchEvidence || null,
      exactStatementAndSamplesVerified: false,
      instructions:
        "The stored source URL and semantic search match identify a related reference, not verified provenance of this local statement or its samples. Call it a related/reference problem in both languages. Do not call it the original source of this statement or samples. Use local samples as authoritative; matching algorithms, constraints or outputs do not prove sample identity. Do not invent a source when absent."
    }
  };
}

/** Reject specific known contradictions; this is not a general factuality proof. */
export function aiTutorialFactViolation(text: string, facts: ReturnType<typeof aiTutorialFacts>): string | null {
  const prose = text.replace(/```[\s\S]*?```/g, "");
  const assertions = prose
    .split(/(?:[。\n!?]|\.(?=\s|$))+/)
    .filter(
      sentence =>
        !/(?:不能|不应|不要|不可|并非|并未|不是|尚未|未核实|无法确认|not |never |cannot |can\x27t |do not |does not )/i.test(
          sentence
        )
    );
  const deniesPartial = assertions.some(sentence =>
    /(?:没有|无|不设|不提供|不支持)[^。\n]{0,16}部分分|no\s+(?:(?:subtasks?\s+(?:or|and)\s+)|(?:partial\s+))?(?:partial\s+)?(?:scores?|credit)|no\s+subtasks?\s+or\s+partial\s+scores?/i.test(
      sentence
    )
  );
  if (
    deniesPartial &&
    (facts.scoring.futureDataGeneration ||
      facts.scoring.currentPartialScoring === "possible" ||
      !facts.scoring.currentSubtasks.length)
  )
    return "UNSUPPORTED_NO_PARTIAL_SCORE_CLAIM";
  if (
    facts.source.relatedReferenceUrl &&
    assertions.some(
      sentence =>
        /(?:题面|样例)[^。\n]{0,30}(?:原始出处|原始来源)|原题(?:面)?[^。\n]{0,30}(?:来自|来源于|出自|参考链接)|(?:引用|参考|来源|原题)(?:页面|网页|链接)[^。\n]{0,35}(?:题面|样例)/.test(
          sentence
        ) ||
        /original\s+source\s+of\s+(?:the\s+)?statement\s+and\s+samples?|(?:original\s+(?:problem\s+)?statement|(?:original|provided)\s+samples?)[^.!\n]{0,100}(?:source|found|available|from|reference|https?:)|(?:source|reference|linked\s+page)[^.!\n]{0,100}(?:original\s+(?:problem\s+)?statement|(?:original|provided)\s+samples?)/i.test(
          sentence
        )
    )
  )
    return "UNVERIFIED_SOURCE_PROVENANCE_CLAIM";
  return null;
}
