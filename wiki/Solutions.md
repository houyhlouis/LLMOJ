# Solutions

[简体中文](Solutions.zh-CN.md) | English | [Wiki home](Home.en.md)

Select **Solutions** within a specific problem page to read or write its solutions, for example `/p/id/<problem-id>?tab=solutions`. Solutions are embedded in the problem page; the top navigation and discussion index have no extra standalone solutions section. Legacy `/solutions?problemId=<id>` links redirect to that problem, or to the problem set when no problem is specified.

A solution is a discussion category, reusing Markdown, replies, reactions, editing and visibility permissions. It is not a duplicated article. **My discussions** includes both ordinary discussions and solutions. The ordinary discussion list defaults to discussions; the embedded solution list displays only that problem's solutions. Replies and editing still use the existing discussion pages.

Choose the solution category and a related problem when creating or editing a post. The problem must exist and be accessible. Private/deleted problems and private team resources remain protected in lists, counts and detail pages; a public solution flag cannot bypass those boundaries.

Authors and users with site-wide discussion moderation permission can reclassify an existing discussion if they can edit it, while preserving its ID, replies and URL. A delegated content-edit permission alone does not allow reclassification. Titles are never used to guess the category of old posts.

New AI-generated solutions are saved directly as solutions. The migration only reclassifies old AI posts whose recorded checkpoint IDs match both their author and problem. Other discussions remain unchanged for explicit author/moderator classification. Reapplying the migration never duplicates posts.

Existing installations need the `discussion.type` column and index. See [Community upgrade](Community-Upgrade.md).
