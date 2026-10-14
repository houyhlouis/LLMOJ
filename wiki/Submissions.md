# Submission previews

[简体中文](Submissions.zh-CN.md) | English | [Wiki home](Home.en.md)

In **Submissions**, click a submission's status, score or language to open its detail in a centered preview. In a contest's **Submissions**, click the submission ID. **My submissions** uses the same preview. The list stays in place, preserving the current filters, page and scroll position.

The **Hacks** list uses the same preview window: status and hack time open the Hack detail, while target submission IDs open the corresponding ordinary or contest submission detail. Closing either preview keeps the Hack list and its filters in place. See [Hacks](Hacks.md).

The preview is a fixed-size mini browser, 1100 × 720 pixels on a sufficiently large screen and constrained to fit smaller screens. It loads the original detail URL inside a same-origin frame and hides only the global navigation bar and its reserved space. The original code, testcases, downloads, moderation, Hack actions and live feedback stay on that page and remain subject to the same server permissions. Contest previews preserve NOI's compilation-only feedback during the contest and the applicable code visibility rules.

Click **#ID** in the preview heading to open the original full detail page. A contest preview keeps the contest in its full-page URL. Ctrl/Cmd-click, Shift-click, middle-click and copying a link retain the normal browser link behavior.

Close the preview with **×**, **Escape**, or a click outside it. A long page scrolls inside the mini browser; the surrounding window keeps its size and the background list stays still. Escape first closes a dialog or dropdown opened inside the original page. Links inside the frame navigate that mini browser; lists opened there use ordinary full-page links to avoid recursive preview windows. Closing or switching pages removes the frame and stops its page subscriptions and timers.

If access is denied or a record was deleted, the original page displays its permission or availability error instead of revealing cached source code. Its refresh action requests fresh data under the current login session. The mini browser is a presentation mode and grants no additional permissions.
