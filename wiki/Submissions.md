# Submission previews

[简体中文](Submissions.zh-CN.md) | English | [Wiki home](Home.en.md)

In **Submissions**, click a submission's status, score or language to open its detail in a centered preview. In a contest's **Submissions**, click the submission ID. **My submissions** uses the same preview. The list stays in place, preserving the current filters, page and scroll position.

The **Hacks** list uses the same preview window: status and hack time open the Hack detail, while target submission IDs open the corresponding ordinary or contest submission detail. Closing either preview keeps the Hack list and its filters in place. See [Hacks](Hacks.md).

The preview is a fixed-size mini browser, 1100 × 720 pixels on a sufficiently large screen and constrained to fit smaller screens. It loads the original detail URL inside a same-origin frame and hides only the global navigation bar and its reserved space. The original code, testcases, downloads, moderation, Hack actions and live feedback stay on that page and remain subject to the same server permissions. Contest previews preserve NOI's compilation-only feedback during the contest and the applicable code visibility rules.

Click **#ID** in the preview heading to open the original full detail page. A contest preview keeps the contest in its full-page URL. Ctrl/Cmd-click, Shift-click, middle-click and copying a link retain the normal browser link behavior.

Close the preview with **×**, **Escape**, or a click outside it. A long page scrolls inside the mini browser; the surrounding window keeps its size and the background list stays still. Escape first closes a dialog or dropdown opened inside the original page. Links inside the frame navigate that mini browser; lists opened there use ordinary full-page links to avoid recursive preview windows. Closing or switching pages removes the frame and stops its page subscriptions and timers.

If access is denied or a record was deleted, the original page displays its permission or availability error instead of revealing cached source code. Its refresh action requests fresh data under the current login session. The mini browser is a presentation mode and grants no additional permissions.

## Test data versions and earlier results

A submission is judged with the problem's judging data as it was when it was submitted: the judge settings, the test data files and the samples it runs form a **data version**, numbered per problem (#1, #2, …). Editing the problem afterwards doesn't change how a waiting submission is judged; submissions made after the edit use the new version. **Rejudge** always uses the problem's current data.

- Users who can rejudge a submission see its data version below the result, marked **current** or **changed since**. Submissions made before data versions were introduced show none; a rejudge gives them one.
- Replaced or removed test data files are kept while a waiting submission still needs them, and deleted afterwards (at the earliest 15 minutes after the change). Removed attachments are deleted at once, as before.
- A rejudge keeps the result it replaces. Users who can rejudge the submission see the five most recent under **Earlier results**: when each was replaced, its status, score, time, memory and data version. Deleting the submission deletes them too.
