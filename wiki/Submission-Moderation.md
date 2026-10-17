# Fake submission moderation

[简体中文](Submission-Moderation.zh-CN.md) | English | [Wiki home](Home.en.md)

Users authorized by **Invalidate cheating submissions (Fake)** can select **Fake**, below **Rejudge / Delete** on its detail page, and confirm the action. An explicit allow or denial for `FakeSubmission` overrides the legacy fallback; without an explicit setting, the submission's existing delete authorization applies. Ordinary and contest submissions are supported. The record becomes `Fake` with an effective score of zero.

The submission ID, code, answer file and original judge results are preserved as evidence. The page distinguishes preserved test results from the effective zero score. Repeated or concurrent Fake actions do not double-decrement statistics.

Fake cancels the active judge task and rejects its late results. Accepted-submission/problem counts and score caches are updated; contest and assignment scores use zero. The submission record and total submission history remain available.

Rejudge can clear Fake and run a fresh evaluation. It requires both rejudge permission and Fake authorization for that record, including explicit Fake denials. Rejudging replaces the current judge detail; the replaced result is kept among the submission's [earlier results](Submissions.md#test-data-versions-and-earlier-results), the five most recent, so export evidence first if it must be retained longer. A user with rejudge permission alone cannot reverse moderation, and batch rejudging does not automatically clear Fake.

In NOI, a Fake latest submission scores zero. IOI may fall back to another valid highest-scoring submission. Strict IOI combines the best valid subtask results and excludes Fake and Hacked records. ICPC treats Fake as an unsuccessful attempt. Other valid submissions and the contest rules determine the resulting score; the fake record never counts as accepted. Score histograms exclude Fake.

An independently verified successful [Hack](Hacks.md) changes the target to `Hacked` with zero effective score while preserving evidence. Restoring such a target requires rejudge authorization plus applicable Hack management authorization; problem or contest managers have the management fallback unless explicitly denied. Restoration queues fresh judging and does not invent an accepted result. The successful hack record remains as history, and repeating its callback cannot invalidate the restored submission again.

Fake and recovery actions are audited. Private team submission access still requires team authorization; scoreboard access does not grant access to another user's code.

Existing databases must append `Fake` and then `Hacked` to the end of `submission.status`, preserving all prior enum values and their order. The migrations also accept the intermediate version with Fake already present. The upgrader and migration scripts validate that contract. See [Community upgrade](Community-Upgrade.md).
