# Contest rules

[简体中文](Contest-Rules.zh-CN.md) | English | [Wiki home](Home.en.md)

LLMOJ supports the following four formats. **NOI / OI** is one format, stored as `noi`; existing contests retain their stored rule and scoring behavior.

| Format | Score | Feedback during the contest | Scoreboard |
| --- | --- | --- | --- |
| NOI / OI | Last submission for each problem | Compilation feedback only | Hidden until the end |
| IOI | Highest score for each problem | Your complete judge feedback | Live |
| ICPC / XCPC | Accepted problem count, then total time | Verdict; detailed test feedback is withheld | Live |
| Strict IOI | Highest score for each subtask across valid submissions, combined per problem | Your complete judge feedback | Hidden until the end |

ICPC adds 20 minutes for each wrong attempt before the first accepted submission. Compilation, file-format and system failures incur no attempt penalty. Attempts after the first accepted submission do not change that problem's result. Time calculations retain second precision.

For score-based formats, each problem's score is multiplied by its configured weight. Existing NOI and IOI use the time of the scoring attempts as a tie-breaker. Strict IOI gives the same rank to equal totals. For example, scoring 40/40 and 0/60 on one submission and 0/40 and 60/60 on another gives 100 in Strict IOI, although neither individual submission scored 100.

Fake and successfully hacked submissions have an effective score of zero. Their preserved original subtask evidence cannot contribute to Strict IOI. Other independent valid submissions may still contribute under IOI or Strict IOI. A mass rejudge skips invalidated records; restoring one requires the corresponding explicit permission.

Contest owners and authorized managers choose the format in **Edit contest**. The format cannot be changed after submissions exist. Teams can create contests with these same four formats. Site contest, submission and scoreboard permissions still apply; team access never bypasses a site-wide deny. Hidden-scoreboard privileges can reveal a hidden board, but still require ordinary scoreboard access.

Hack follows its contest switch and opening window. **Self Eval is optional only for NOI / OI contests**, is disabled by default, and appears on the contest problem page when enabled. Managers prepare a fixed hidden prediction set before the contest using `make.cpp` and `std.cpp`; judging reuses the problem's formal SPJ. Neither feature awards bonus points or changes the scoring formula, and Self Eval does not expose official scores or judge data. See [Hacks](Hacks.md) and [Self Eval](Self-Evaluation.md) for configuration and whole-contest quotas.

The original scoring formats follow the [Luogu contest manual](https://help.luogu.com.cn/manual/luogu/contest). Strict IOI's per-subtask aggregation and hidden live scoreboard are based on the [Hydro contest implementation](https://github.com/hydro-dev/Hydro/blob/master/packages/hydrooj/src/model/contest.ts).
