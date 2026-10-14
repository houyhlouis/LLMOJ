# Hacks

[简体中文](Hacks.zh-CN.md) | English | [Wiki home](Home.en.md)

**Hack** follows **Submissions** in navigation. The **View all** button in the home page's **Top Users** panel opens Members. It displays results only, using the submission list's filter, table and pagination layout. An empty result keeps the empty table. Columns include status, target submission ID, problem, submitter, hacker, runtime, memory and hack time. Filter by problem ID, hacker username, target submission ID or status. **My hacks** filters the current account. Contests also have a hack results tab.

The **Manage problem STD** editor places **Back** and **Submit** beside the page heading, matching the other problem editing pages.

Click a Hack's **status** or **hack time** to open its original detail URL in the centered fixed-size mini browser described in [Submission previews](Submissions.md). Its one Hack testcase stays expanded, including the permitted input, verdict, runtime, memory and authorized rejudge controls. The detail status uses the same colored text as the list, without a filled label. Click a **target submission ID** to load the original ordinary or contest submission instead. The list keeps its current filters, contest, page and scroll position. Only one preview opens at a time.

Use **×**, **Escape**, or a click outside the preview to close it; the original page scrolls inside a window whose size stays fixed. Click the heading's **#ID** to open its normal full detail URL. Modified clicks, middle-click and copied links keep normal browser behavior. The mini browser loads the complete original page while hiding the global top navigation. Running Hack records keep their original updates, which stop when the frame is removed; Hack and contest access permissions still apply.

## Configure the trusted STD

A problem manager opens **STD / Hack reference** from the traditional problem's management menu, at `/p/id/<problemId>/hack-reference`. Enter the trusted STD in the code editor, choose its language and compilation options, and save. The STD generates the correct answer for hack input; the checker / SPJ and resource limits use the problem's formal judging configuration.

The STD uses standard input/output by default, independently of the target's file I/O. If its code reads and writes files, enable **STD uses file input/output** and enter the exact input and output filenames. The names must be distinct, contain letters, numbers, spaces, underscores, hyphens or dots, and fit within 255 UTF-8 bytes; paths, names starting with `..`, `.` and the reserved `hack-stderr` are rejected. The target keeps the ordinary problem's file I/O or the contest filenames recorded when it was submitted.

Alternatively, open a finished Accepted submission for this problem whose source you may view, click **Use as problem STD**, and confirm. This copies its source, language, compilation options and applicable file I/O (recorded contest filenames for contest submissions; formal problem settings for ordinary submissions) and retains the source submission ID as manager-only provenance. Hackers never enter a reference submission ID. The source submission cannot itself be hacked. Later rejudging or changing its record does not change the saved STD copy.

The manager page automatically loads an available immutable formal-data validator, or the test-data file `validator.cpp`. When none is available, expand **Input validator** and enter its source in the code editor. A validator reads standard input and exits with 0 only for valid input; invalid input must produce a nonzero exit code. C++ validators may use the bundled testlib header. Each STD or validator source is limited to 1 MiB.

Only managers with the applicable problem and Hack configuration permissions can change this configuration. An explicit `ManageHack` denial overrides the problem-management fallback. Older reference-submission configurations remain readable; saving the STD converts them to independent source copies. Existing saved references without separate file I/O retain their source submission's applicable I/O, or the formal problem settings when no source remains. Already queued legacy tasks retain the I/O in their original judging snapshot. New tasks snapshot STD and target I/O separately; changing the trusted STD or its I/O cancels incompatible tasks.

## Create a hack

The **Hack button exists only on a concrete submission detail page**, not in the submissions list or hack results pages. Both ordinary and contest submissions for traditional code problems are supported.

1. Open the target submission and click **Hack**.
2. Upload a UTF-8 input file or paste one complete input, at most 1 MiB.
3. Submit, then follow the link to its result record.

The dialog only requests input. Managers configure the trusted STD and validator in advance. The target must be finished, runnable, accessible and not canceled, Fake or Hacked. Applicable problem, team and contest permissions still apply.

The judge validates the input, runs the STD to obtain the expected answer, and evaluates the target with the formal checker / SPJ. Invalid input, STD/configuration failures and system errors are distinct from an unsuccessful hack. Only a valid counterexample produces **Success**. Each account may have at most three active hacks and create at most thirty per hour.

The detail page displays **Testcase #1** in the submission judging style, permanently expanded. It shows the target's actual testcase verdict and score when recorded, plus runtime, memory, input and a safe judging message; the filename button downloads the complete input. It does not include the target's original testcases or private STD output/checker diagnostics. Invalid input and preparation failures show **Not run** when the target never executed. Older records without a stored target verdict retain the Hack result and say **Target verdict not recorded**, without guessing a verdict. Contest privacy rules still apply to the input and message.

## Successful hacks

Success preserves the target ID, source and original judging evidence, changes its effective status to `Hacked`, and assigns zero effective score. Problem statistics and contest standings update. Repeated result callbacks cannot apply the same hack twice.

A successful hack remains historical and cannot be undone by rejudging the hack record. Restoring its target requires submission rejudge and applicable Hack management authorization, followed by rejudging that original submission. Managers can retry unsuccessful or error records.

## Contests and permissions

Hack is disabled by default for contests. Managers can enable it and configure the opening and closing times. The default opening time is the contest end; NOI/OI and Strict IOI participants cannot hack until the contest ends, protecting hidden results. Enabling Hack does not grant access to opponents' source code.

Permissions include **View hack records**, **Create hacks**, and **Manage hacks, references and validators**. Private team resources retain independent membership and resource access checks. Input and messages obey contest privacy rules.

[Self-evaluation](Self-Evaluation.md) is an optional NOI/OI contest pretest feature and has no ordinary submission-page entry. See [Community upgrade](Community-Upgrade.md) for database and judge compatibility checks.
