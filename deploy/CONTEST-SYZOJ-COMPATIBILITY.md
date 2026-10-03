# Contest implementation and SYZOJ compatibility

The contest features below correspond to [SYZOJ](https://github.com/syzoj/syzoj) and use LibreOJ's NestJS/TypeORM API and React/Semantic UI frontend.

| SYZOJ source feature | This project's implementation |
| --- | --- |
| `modules/contest.js`: paginated public contest list; private contests for supervisors | `/contests`; contest visibility and per-user ViewContest/ViewHiddenContest permissions |
| Create/edit title, subtitle, information, start/end time | Contest management page, Markdown/LaTeX information, local-time input stored as UTC |
| NOI, IOI, ACM/ICPC; prohibit changing rules after activity | All three rules; rule changes rejected after submissions exist |
| Holder and contest administrators | Owner and administrator ID list; EditContest/ManageContest permissions |
| Ordered problem list | Contest problem ordering, independent displayed title |
| Per-problem ranking multipliers | Positive score weights, applied to NOI/IOI results |
| `hide_statistics` | Attempt/accepted statistics hidden while requested, revealed to managers and after contest |
| Contest problem availability | Statements and contest attachment downloads blocked before start; managers can prepare in advance |
| Contest submissions and contestant/problem filtering | Paginated contest submission page; filtering by user and problem |
| NOI feedback | Last submission scores; during contest only pending/compilation success/failure is returned to contestants |
| IOI feedback | Best score per problem; own results and test-case verdict/usage feedback during contest |
| ICPC feedback | Other participants' verdicts visible, source kept private; public running standings |
| `models/contest_player.ts`: compile-error exclusion, first AC, twenty-minute penalties | Implemented; later submissions after first AC do not increase penalty |
| `models/contest_ranklist.ts`: score/time tie breaking | NOI/IOI use latest counted submission time; ICPC uses total elapsed seconds plus penalties; tied rows share ranks |
| Post-contest standings and feedback | Revealed at contest end; late ordinary submissions rejected |
| Contest additional-file download | Independent attachments, checked signed downloads; existing public-problem attachments stay unchanged |

Contest settings: contest-scoped file input/output names are copied into each submission, then overlaid on the judge task without modifying the public problem's judge information. Language allowlists can constrain any built-in language, each ISO C++ standard (03, 11, 14, 17, 20, 23 and 26) and its GNU counterpart, and Python 2.7, 3.9 or 3.10 individually. Allowed versions follow the built-in `CPP_STANDARDS` and `PYTHON_VERSIONS` options. Each user's summaries remain private, contain Markdown/LaTeX per-problem and overall notes plus completion minutes, and are listed in My Summaries. Dedicated permissions cover contest creation, editing, participation, visibility, standings, hidden standings, CSV export, and summaries.

All regular submission queries, latest-submission widgets, public problem statistics, and leaderboard cache rebuilds exclude contest submissions. The regular submission detail endpoint does not bypass running-contest feedback rules. Contest result metadata is serialized through an explicit allowlist, and test-input/output/checker contents are not included in contestant result responses.

The contest feature set does not include virtual participation, a registration/password gate or timed scoreboard freezing.
