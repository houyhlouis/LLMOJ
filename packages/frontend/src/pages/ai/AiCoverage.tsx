import React from "react";
import { aiText, AiJob } from "./api";
import style from "./Ai.module.less";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * How a test data job's cases cover its quality targets (review Part III, W05): the differential checks and their
 * distinct inputs, each target's witness and how many cases it ran on, the cases replaced by counterexamples, the
 * extra search, and the subtasks given more cases than their share of points so that their targets can be built.
 */
export default function AiCoverage({ result }: { result: AiJob["result"] }) {
  const quality = result.testdataQuality?.version === 1 ? result.testdataQuality : null;
  const search = quality?.search;
  return (
    <>
      {(result.caseCapacity || []).map(item => (
        <p className={style.jobDetail} key={`capacity-${item.subtask}`}>
          {aiText(
            `子任务 ${item.subtask} 有 ${item.to} 个测试点（按分值应为 ${item.from} 个），以便为 ${item.targets.join(
              "、"
            )} 构造反例；其分值由这 ${item.to} 个测试点平分。`,
            `Subtask ${item.subtask} has ${item.to} test cases instead of ${
              item.from
            }, so that a counterexample can be built for ${item.targets.join(", ")}; its points are shared by its ${
              item.to
            } test cases.`
          )}
        </p>
      ))}
      {quality && (
        <>
          <p className={style.jobDetail}>
            {aiText(
              `对拍通过 ${quality.fuzzPassed} 组${
                quality.fuzzDistinct != null ? `（${quality.fuzzDistinct} 个不同的输入）` : ""
              } · ${quality.alternativeCount} 种额外正解通过 ${quality.alternativesPassed} 次数据检验 · 已拦截 ${
                quality.challengesKilled
              }/${quality.challengeCount} 个错误或低效算法`,
              `${quality.fuzzPassed} differential checks passed${
                quality.fuzzDistinct != null
                  ? ` on ${plural(quality.fuzzDistinct, "distinct input", "distinct inputs")}`
                  : ""
              } · ${quality.alternativeCount} alternative correct solution(s) passed ${
                quality.alternativesPassed
              } data checks · ${quality.challengesKilled}/${quality.challengeCount} wrong or slow algorithms rejected`
            )}
          </p>
          {quality.challengeResults.map(target => (
            <p className={style.jobDetail} key={target.id}>
              {target.id}
              {" · "}
              {aiText(
                `第 ${target.killedBy} 个测试点：${target.verdict}`,
                `Test case ${target.killedBy}: ${target.verdict}`
              )}
              {target.tested != null &&
                target.kills != null &&
                aiText(
                  ` · 运行过的 ${target.tested} 个测试点中有 ${target.kills} 个拦截了它`,
                  ` · rejected by ${target.kills} of the ${plural(target.tested, "test case", "test cases")} it ran on`
                )}
            </p>
          ))}
          {(quality.replacements || []).map(item => (
            <p className={style.jobDetail} key={`replacement-${item.case}`}>
              {aiText(
                `第 ${item.case} 个测试点已替换为${
                  item.source === "small_counterexample" ? "对拍中发现的小规模反例" : "额外搜索找到的反例"
                }（拦截 ${item.kills.join("、")}${item.moved.length ? `；${item.moved.join("、")} 的见证转移到它` : ""}）`,
                `Test case ${item.case} replaced by ${
                  item.source === "small_counterexample"
                    ? "a small counterexample from differential testing"
                    : "a counterexample found by search"
                } (rejects ${item.kills.join(", ")}${
                  item.moved.length ? `; the witness for ${item.moved.join(", ")} moved to it` : ""
                })`
              )}
            </p>
          ))}
          {search && (search.attempts > 0 || search.promoted > 0) && (
            <p className={style.jobDetail}>
              {[
                // The search's own attempts; a small counterexample from differential testing isn't one of them
                search.attempts > 0 &&
                  aiText(
                    `额外搜索：尝试 ${search.attempts}/${search.budget} 次 · 找到 ${search.found - search.promoted} 个反例${
                      search.unplaced ? `，其中 ${search.unplaced} 个无法放入` : ""
                    }`,
                    `Extra search: ${search.attempts} of ${search.budget} attempts · ${plural(
                      search.found - search.promoted,
                      "counterexample",
                      "counterexamples"
                    )} found${search.unplaced ? `, ${search.unplaced} not placed` : ""}`
                  ),
                search.promoted > 0 &&
                  aiText(
                    `采用 ${search.promoted} 个对拍中的小规模反例`,
                    `${plural(search.promoted, "small counterexample", "small counterexamples")} from differential testing used`
                  )
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </>
      )}
    </>
  );
}
