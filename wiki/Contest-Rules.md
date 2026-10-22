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

**Strict IOI and changed problems.** Subtask results add up only between submissions judged with the same [data version](Submissions.md#test-data-versions-and-earlier-results) of the problem and the same subtask weights. A changed problem can reorder or redefine its subtasks without changing their weights, so results of two versions never combine. If a problem changes during a contest, a contestant's score for it is their best combination within one version. On the scoreboard, such a score is marked with **\***; point at it for the number of versions. Results from before data versions combine only with each other.

**Accepted means full marks.** A Strict IOI problem counts as accepted only when every subtask has full marks. Problem scores are shown and ranked rounded to whole points, so 50/50 and 49.6/50 show as 100 points but aren't accepted (green on the scoreboard, counted as solved). The best combination is chosen by its exact score.

**Fake and hacked submissions** score 0, and their original subtask results never count towards Strict IOI. Under IOI and Strict IOI, the contestant's other valid submissions still count. Rejudging many submissions at once skips them; restoring one needs explicit permission (see [Fake moderation](Submission-Moderation.md)).

## Who sees what

Contest managers see everything, at any time. Everyone else can open the problems once the contest starts. While it runs, they see:

| | NOI / OI | IOI | ICPC / XCPC | Strict IOI |
| --- | --- | --- | --- | --- |
| Other contestants' submissions | After the end | After the end | Verdicts only | After the end |
| How many tried and solved each problem | After the end | Live | Live | After the end |

- Contest pages never show other contestants' code. After the end, they show everyone's results, but still not their code.
- **Hide problem statistics** (under **Edit contest**) hides the counts until the end, whatever the rule.
- Under NOI / OI and Strict IOI, other contestants can't see a hack's input and messages until the end.

## Choosing a rule

Contest owners and managers choose the rule under **Edit contest**. It can't be changed once the contest has submissions. Team contests use the same four rules.

The site's permissions for contests, submissions and scoreboards always apply, and team permissions never override a site-wide deny. The **View hidden scoreboards** permission shows a hidden scoreboard, but the user also needs ordinary scoreboard access.

## Hacks and Self Eval

- [Hacks](Hacks.md) are possible only when the contest allows them, and only in the time window it sets.
- [Self Eval](Self-Evaluation.md) is an option of **NOI / OI contests only**, off by default. When it's on, contest problem pages show a **Self Eval** button that runs your code on hidden pretests prepared before the contest, judged with the problem's own checker.

Neither gives bonus points or changes how scores are calculated, and Self Eval never reveals official scores or test data.

## Exports and summaries

**Export** (on the scoreboard) downloads a CSV file for spreadsheets: UTF-8 with a byte order mark. Text that a spreadsheet could take for a formula gets a leading apostrophe, also when it follows spaces or control characters. Team assignment exports follow the same rules.

**My summaries** keeps the notes you wrote about each contest. If you can no longer open a contest (you left its team, or it became private), your notes stay, but the list shows **Contest unavailable** instead of the contest's current title.

## Sources

The original scoring rules follow the [Luogu contest manual](https://help.luogu.com.cn/manual/luogu/contest). Strict IOI's per-subtask scoring and hidden scoreboard follow [Hydro's contest implementation](https://github.com/hydro-dev/Hydro/blob/master/packages/hydrooj/src/model/contest.ts).
