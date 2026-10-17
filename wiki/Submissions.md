# Submissions

[简体中文](Submissions.zh-CN.md) | English | [Wiki home](Home.en.md)

## Submission previews

In **Submissions** and **My submissions**, click a submission's status, score or language to open its details in a preview window; in a contest's **Submissions**, click the submission ID. The list stays as it was, with its filters, page and scroll position. The **Hacks** list works the same way: a hack's status or time opens the hack, and its target submission ID opens that submission (see [Hacks](Hacks.md)).

The preview shows the submission's normal page (1100 × 720 pixels, smaller on small screens) without the site's top navigation, so code, testcases, downloads, moderation, Hack and live updates all work as usual and follow the same permissions. Contest rules still apply, for example NOI / OI contests showing only compilation results during the contest.

- Click **#ID** in the preview's heading to open the full page; a contest submission opens within its contest. Ctrl/Cmd-click, Shift-click, middle-click and copying the link behave as for any link.
- Close the preview with **×**, **Escape** or a click outside it. Escape first closes any dialog or menu open in the preview. A long page scrolls inside the preview.
- Links in the preview open inside it; lists opened there use ordinary links, so previews never nest.
- If you can't access the submission or it was deleted, the preview shows the page's usual error instead of the code. The preview never grants more access than the page itself.

## Test data versions and earlier results

A submission is judged with the problem's judging data as it was when it was submitted: the judge settings, the test data files and the samples it runs form a **data version**, numbered per problem (#1, #2, …). Editing the problem afterwards doesn't change how a waiting submission is judged; submissions made after the edit use the new version. **Rejudge** always uses the problem's current data.

- Users who can rejudge a submission see its data version below the result, marked **current** or **changed since**. Submissions made before data versions were introduced show none; a rejudge gives them one.
- Replaced or removed test data files are kept while a waiting submission still needs them, and deleted afterwards (at the earliest 15 minutes after the change). Removed attachments are deleted at once.
- A rejudge keeps the result it replaces. Users who can rejudge the submission see the five most recent under **Earlier results**: when each was replaced, its status, score, time, memory and data version. Deleting the submission deletes them too.
