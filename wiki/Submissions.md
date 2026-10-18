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
- A rejudge keeps the result it replaces. Users who can rejudge the submission see the five most recent under **Earlier results**: when each was replaced, its status, score, time, memory, data version and what judged it. Deleting the submission deletes them too.

### Content hashes

Every stored file gets a SHA-256 when it's accepted: uploaded test data, attachments and answer files, imported archives, and files that AI and Self Eval add. Files stored before this was introduced are hashed in the background, up to 1 GiB a minute; `deploy/doctor.sh` shows how many are left. A data version records the hashes of its test data files, and problem managers see a file's SHA-256 by pointing at its size on the problem's files page.

Before judging, a judge checks each test data file and each submitted answer file against its hash, also the copies it kept from earlier tasks. A damaged copy is downloaded again. A file whose stored content changed after it was accepted makes the submission fail with **System Error** ("… doesn't match its recorded content") instead of being judged with other data than the other judges; upload that file again, then rejudge. Files without a hash yet are used as before.

### What judged a result

Users who can rejudge a submission also see what judged its result: the judge machine, its **judge program** (a digest of the judge's source files) and its **sandbox image** (which identifies its compilers and interpreters). Click it for the Node.js version, system and CPU. **Earlier results** show the same for each replaced result. Results from before this was introduced, and from judges older than protocol version 3, show **not recorded**.
