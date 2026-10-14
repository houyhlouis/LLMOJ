import { tr } from "./api";

export function ruleLabel(rule: string) {
  return (
    {
      noi: "NOI / OI",
      ioi: "IOI",
      acm: "ICPC / XCPC",
      strictioi: tr("严格 IOI", "Strict IOI")
    }[rule] ?? rule.toUpperCase()
  );
}

export function ruleChoices() {
  return ["noi", "ioi", "acm", "strictioi"].map(value => ({ value, text: ruleLabel(value) }));
}

export function ruleDescription(rule: string) {
  return (
    {
      noi: tr(
        "NOI / OI：最后一次提交计分，比赛期间仅显示编译结果。",
        "NOI / OI: the last submission counts; only compilation feedback is available during the contest."
      ),
      ioi: tr(
        "IOI：每题最高分计分，赛时可看自己的完整评测结果及榜单。",
        "IOI: the best score counts; your full results and the scoreboard are visible during the contest."
      ),
      acm: tr(
        "ICPC：按通过题数及罚时排名，编译失败不计罚时，每次错误罚时 20 分钟。",
        "ICPC: rank by solved problems and penalty; compilation errors incur no penalty, other wrong attempts add 20 minutes."
      ),
      strictioi: tr(
        "严格 IOI：每个子任务取历次提交最高分，再合并计分；自己的结果实时可见，榜单在赛后公开。",
        "Strict IOI: combine the best result for each subtask across submissions; your results are live and the scoreboard opens after the contest."
      )
    }[rule] ?? ""
  );
}
