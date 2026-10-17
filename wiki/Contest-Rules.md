# Contest rules

[简体中文](Contest-Rules.zh-CN.md) | English | [Wiki home](Home.en.md)

A contest uses one of four rules. **NOI / OI** is a single rule (stored as `noi`).

| Rule | Score | Feedback during the contest | Scoreboard |
| --- | --- | --- | --- |
| NOI / OI | Last submission to each problem | Compilation result only | Hidden until the end |
| IOI | Best score on each problem | Your full judging results | Live |
| ICPC / XCPC | Problems solved, then total time | Verdict only, without test details | Live |
| Strict IOI | Best result on each subtask across all valid submissions, added up per problem | Your full judging results | Hidden until the end |

**ICPC:** each wrong attempt before a problem is accepted adds 20 minutes. Compile errors, file-format errors and system errors add nothing, and submissions after the first accepted one don't change the problem's result. Times are counted to the second.

**Score-based rules** multiply each problem's score by its weight. NOI / OI and IOI break ties by the time of the submissions that scored; Strict IOI ranks equal totals equally. In Strict IOI, a contestant who scores 40/40 and 0/60 on the two subtasks in one submission, and 0/40 and 60/60 in another, gets 100 for the problem, though neither submission scored 100.

**Fake and hacked submissions** score 0, and their original subtask results never count towards Strict IOI. Under IOI and Strict IOI, the contestant's other valid submissions still count. Rejudging many submissions at once skips them; restoring one needs explicit permission (see [Fake moderation](Submission-Moderation.md)).

## Choosing a rule

Contest owners and managers choose the rule under **Edit contest**. It can't be changed once the contest has submissions. Team contests use the same four rules.

The site's permissions for contests, submissions and scoreboards always apply, and team permissions never override a site-wide deny. The **View hidden scoreboards** permission shows a hidden scoreboard, but the user also needs ordinary scoreboard access.

## Hacks and Self Eval

- [Hacks](Hacks.md) are possible only when the contest allows them, and only in the time window it sets.
- [Self Eval](Self-Evaluation.md) is an option of **NOI / OI contests only**, off by default. When it's on, contest problem pages show a **Self Eval** button that runs your code on hidden pretests prepared before the contest, judged with the problem's own checker.

Neither gives bonus points or changes how scores are calculated, and Self Eval never reveals official scores or test data.

## Sources

The original scoring rules follow the [Luogu contest manual](https://help.luogu.com.cn/manual/luogu/contest). Strict IOI's per-subtask scoring and hidden scoreboard follow [Hydro's contest implementation](https://github.com/hydro-dev/Hydro/blob/master/packages/hydrooj/src/model/contest.ts).
