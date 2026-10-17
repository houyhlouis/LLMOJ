# Hacks

[简体中文](Hacks.zh-CN.md) | English | [Wiki home](Home.en.md)

A **Hack** challenges a submission with an input of your own. The judge runs the problem's trusted solution (the STD) to get the correct answer and checks the submission against it. If the submission fails, the hack succeeds and the submission's score is voided.

## Hack records

**Hack** in the top navigation lists hack results, with the same filters, table and pagination as **Submissions**: filter by problem ID, hacker, target submission ID or status, or click **My hacks**. Each record shows its status, target submission, problem, submitter, hacker, runtime, memory and time. When nothing matches, the page says **No hacks** (or **No matching hacks** with filters). Contests have their own **Hacks** tab.

Clicking a record's **status** or **time** opens its detail in a preview window, and clicking the **target submission** opens that submission; see [Submission previews](Submissions.md). The list keeps its filters, page and scroll position.

## Set up the trusted STD

Hacks need a trusted solution for the problem. A problem manager clicks **Reference code / STD** in the sidebar of a traditional problem's page (`/p/id/<problemId>/hack-reference`), enters the STD in the code editor, chooses its language and compiler options, and saves. The STD produces the correct answer for each hack input; the checker and the time and memory limits are the problem's own.

The STD reads standard input and writes standard output, whatever file I/O the problem uses. If it reads and writes files instead, turn on **STD uses file input/output** and enter the two file names. They must differ, use only letters, digits, spaces, underscores, hyphens and dots, and be at most 255 bytes; paths, names starting with `..`, `.` and `hack-stderr` aren't allowed. The hacked submission keeps the file I/O it was judged with.

You can also copy an Accepted submission's code: open a finished Accepted submission of the problem whose code you can see, click **Use as problem STD** and confirm. Its code, language, compiler options and file I/O are copied, and its ID is shown to managers as the source. That submission can't be hacked itself, and later changes to it don't change the saved STD.

Hack inputs are checked by a validator before they run. The page uses the problem's test data validator when there is one (including a `validator.cpp` among the test data); otherwise, expand **Input validator** and enter one. A validator reads the input from standard input and exits with 0 if it's valid, or nonzero if not; C++ validators can use the bundled testlib. The STD and the validator are each limited to 1 MiB.

Only users who can manage the problem and its Hacks can change these settings; an explicit `ManageHack` denial takes precedence over problem management. Changing the STD or its file I/O cancels queued hacks that no longer match it.

## Hack a submission

Hacks are started only from a submission's detail page, for ordinary and contest submissions of traditional problems.

1. Open the submission and click **Hack**.
2. Upload a UTF-8 input file or paste the input, at most 1 MiB.
3. Click **Submit hack**, then open the new record to see the result.

The submission must be finished, must have compiled and run, and must not be Canceled, Fake or already Hacked; you also need access to its problem, team and contest. Each account can have at most 3 hacks in progress and start at most 30 per hour.

The judge first validates the input, runs the STD for the correct answer, then judges the submission with the problem's checker. Only a valid input that makes the submission fail is a **Success**; invalid input, a problem with the STD or its configuration, and system errors are reported separately.

The record's detail shows a single **Testcase #1**, like a submission's judging details: the submission's verdict and score on your input, runtime, memory, the input (download it with the file name button) and the judge's message. It doesn't show the submission's other testcases, the STD's output or the checker's internal messages. When the submission never ran (for example, the input was invalid), it shows **Not run**. Contest rules about hidden information still apply.

## Successful hacks

The hacked submission keeps its ID, code and original judging details, but its status becomes `Hacked` and its score 0; problem statistics and contest standings are updated.

A successful hack stays on record; rejudging the hack doesn't undo it. To restore the submission, a user who can rejudge submissions and manage Hacks rejudges it. Unsuccessful hacks and errors can be retried by managers.

## Contests and permissions

Hacks are off by default in contests. Contest managers can turn them on and set when hacking opens and closes; by default it opens when the contest ends. In NOI / OI and Strict IOI contests, contestants can hack only after the contest, so that hidden results stay hidden. Turning on Hacks doesn't let anyone see other contestants' code.

The permissions are **View hack records**, **Create hacks**, and **Manage all hacks, references, and validators**. Team resources still need team membership and access.

[Self Eval](Self-Evaluation.md) is a separate pretest feature of NOI / OI contests. For database and judge compatibility when upgrading, see [Feature upgrades](Community-Upgrade.md).
