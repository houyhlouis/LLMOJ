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

## Writing your code

A contest problem page has the same code editor as the problem set. What you write there is kept as a **draft in your browser**, so reloading the page, closing the tab or following a link doesn't lose it:

- There is one draft for each account, contest, problem and language. Choosing another language brings back that language's draft; if it has none, the code in the editor moves to it.
- The page opens with the draft you changed last. Submitting keeps the draft, so the code is still there to fix after a wrong answer.
- The draft is saved when you pause typing for half a second, and at once when you leave the page. It stays in this browser: it isn't sent to the server, and it isn't a submission.
- When submissions have closed, the page still shows your draft, read-only, so you can copy it.
- **Discard draft** deletes the draft of the selected language, after asking, and empties the editor.
- Drafts are deleted when you sign out, when another account signs in on that browser, and 14 days after their last change. On a shared computer, sign out when you leave.
- A browser keeps at most 50 drafts, the most recently changed ones, and none longer than 1 MiB (the most code a submission takes). Where the browser can't keep a draft (its storage is full or turned off, as in some private windows), the page says so.

## Virtual participation

After a contest has ended, someone who didn't take part can take it later, as if it were live: a **virtual run**.

- **Who:** any user who may open the contest and enter contests, if they made no submission in the contest while it ran (any submission counts, even one judged Fake or canceled; one an administrator deleted doesn't). The contest's managers can't. Each user gets one virtual run per contest.
- **How long:** the run starts when you press **Start virtual participation** on the contest page and lasts as long as the contest did. It can't be paused.
- **During the run** the contest behaves as if it were running, under its own rule: you submit, you get the feedback the rule gives contestants, and Hacks and Self Eval aren't available. Contests running live are judged first, so a virtual run's submissions can wait longer when the judges are busy. The scoreboard shows the contest as it stood at the same point in time: the official contestants' submissions made up to that moment, other virtual runs' submissions made up to the same point of theirs, and yours. A rule that hides the scoreboard during a contest (NOI / OI, Strict IOI) hides it during your run too.
- **For managers:** once anyone has started a virtual run, the contest's start and end can't change any more (the rest of its settings can). Virtual submissions can't be hacked, but Fake moderation and rejudging apply to them as to any other.
- **Afterwards** the contest is ended for you as for everyone. Your run counts nowhere officially: the scoreboard, its export and the statistics stay the official ones. **Show virtual participants** on the scoreboard adds the virtual runs, marked, ranked together with the official contestants by the same rule, with their times counted from the start of each run.

## Exports and summaries

**Export** (on the scoreboard) downloads a CSV file for spreadsheets: UTF-8 with a byte order mark. Text that a spreadsheet could take for a formula gets a leading apostrophe, also when it follows spaces or control characters. Team assignment exports follow the same rules.

**My summaries** keeps the notes you wrote about each contest. If you can no longer open a contest (you left its team, or it became private), your notes stay, but the list shows **Contest unavailable** instead of the contest's current title.

## Sources

The original scoring rules follow the [Luogu contest manual](https://help.luogu.com.cn/manual/luogu/contest). Strict IOI's per-subtask scoring and hidden scoreboard follow [Hydro's contest implementation](https://github.com/hydro-dev/Hydro/blob/master/packages/hydrooj/src/model/contest.ts).
