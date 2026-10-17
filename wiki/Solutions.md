# Solutions

[简体中文](Solutions.zh-CN.md) | English | [Wiki home](Home.en.md)

Each problem page has a **Solutions** tab (for example `/p/id/<problemId>?tab=solutions`) where you read the problem's solutions and write your own. There is no separate solutions section elsewhere on the site. Old `/solutions?problemId=<id>` links lead to the problem, or to the problem set when they name no problem.

A solution is a kind of discussion: it has Markdown, replies, reactions, editing and the same visibility permissions as any discussion. **My discussions** lists both your discussions and your solutions. The discussion list shows ordinary discussions by default, and a problem's **Solutions** tab shows only that problem's solutions; replying and editing use the usual discussion pages.

To post a solution, create a discussion, choose the **Solution** type and the problem it belongs to. You need access to that problem. A solution of a private or deleted problem, or of a private team's problem, stays hidden from anyone without access, in lists, counts and on its own page; marking a solution public doesn't change that.

The author, or a user who can moderate discussions site-wide, can change an existing discussion into a solution (or back) if they can edit it; its ID, replies and link stay the same. Permission to edit a single discussion isn't enough to change its type. Old posts are never classified by guessing from their titles.

Solutions written by AI are saved as solutions directly. When upgrading, older AI-written posts become solutions only when the AI job's record names both the post and its problem; everything else stays an ordinary discussion for its author or a moderator to classify. Running the migration again never creates copies.

Installations from before solutions existed need the `discussion.type` column and its index; see [Feature upgrades](Community-Upgrade.md).
