# Fake moderation

[简体中文](Submission-Moderation.zh-CN.md) | English | [Wiki home](Home.en.md)

When a submission is found to be cheating, a user with the **Invalidate cheating submissions (Fake)** permission for it can mark it **Fake**: click the submission's status at the top of its page, choose **Fake (disqualify)** and confirm. Its status becomes `Fake` and its score counts as 0. This works for ordinary and contest submissions. An explicit allow or deny of `FakeSubmission` decides who may do it; without one, whoever may delete the submission may also mark it Fake.

The submission's ID, code, answer file and original judging results are kept as evidence, and its page shows them separately from the zero score. Marking a submission Fake twice, or by two people at once, changes the statistics only once.

Marking a submission Fake cancels any judging still in progress and ignores results that arrive later. The accepted counts of the submitter and the problem, and cached score statistics, are updated; contests and assignments count the submission as 0. The submission itself stays in the submission history.

Rejudging a Fake submission clears the Fake mark and judges it again. This needs both the rejudge permission and the Fake permission for that submission (an explicit Fake denial also blocks it), so the rejudge permission alone can't undo moderation, and rejudging many submissions at once doesn't clear Fake marks. The rejudge keeps the Fake result among the submission's [earlier results](Submissions.md#test-data-versions-and-earlier-results) (the five most recent); export the evidence first if you need it for longer.

In contests:
- **NOI / OI:** if the last submission is Fake, the problem scores 0.
- **IOI:** the best other valid submission to the problem counts instead.
- **Strict IOI:** each subtask's best result comes from valid submissions only, never from Fake or Hacked ones.
- **ICPC:** a Fake submission counts as a wrong attempt.

A Fake submission never counts as accepted, and score histograms leave it out.

A successful [Hack](Hacks.md) similarly marks its target `Hacked` with a score of 0 and keeps the evidence. Restoring a hacked submission needs the rejudge permission and the permission to manage Hacks (problem and contest managers have it unless explicitly denied); it judges the submission again rather than restoring its old result. The successful hack stays on record and can't void the restored submission a second time.

Marking and restoring are recorded in the audit log. Submissions in private teams still need team access, and being able to see a scoreboard doesn't let anyone see other users' code.

Installations upgrading from before this feature add `Fake` and then `Hacked` to the end of the `submission.status` values, keeping the existing values in order (a version that already has `Fake` is accepted too). The upgrader checks this; see [Feature upgrades](Community-Upgrade.md).
