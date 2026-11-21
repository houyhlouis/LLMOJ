# Study lists and discussions

[简体中文](Study-Lists-and-Discussions.zh-CN.md) | English | [Wiki home](Home.en.md)

## Study lists

**Study lists** (in the top bar) are your own lists of problems to work through. They're private: nobody else can open them, administrators included. Teams have assignments for sharing work with members instead (see [Teams](Teams.md)).

- A list has a title (up to 160 characters), a description in Markdown, and up to 1,000 problems. Each problem can have a section heading (up to 120 characters) and a note (up to 10,000 characters), and appears once.
- You can add only problems you can open. If you later lose access to one, it stays in the list but shows as unavailable.
- Each problem shows your latest accepted submission outside contests, as in the problem set.
- **Star** a list to mark it; **archive** one you've finished to keep it out of the default view. Search finds lists by title.
- If the same list was saved elsewhere since you opened it (in another tab, say), saving is refused: reload it and make your change again.

Study lists need the **Manage own private study lists** permission, which every signed-in user has by default (see [Permissions](Permissions.md)).

## Discussions

Discussions are on their own pages and on problem pages; [solutions](Solutions.md) are discussions too and follow the same rules. The permissions named below are explained in [Permissions](Permissions.md); the `preference.security` settings are in the [backend configuration](Backend-Configuration.md#preferencesecurity).

### Who may post

| To | Needs |
| --- | --- |
| Start a discussion | **Create discussions and tutorials** (with `allowEveryoneCreateDiscussion` on, every signed-in user may) |
| Reply | **Reply to discussions** |
| React with an emoji | **React to discussions** |
| Edit or delete your own discussion | **Edit own discussions**, **Delete own discussions** |
| Edit your own reply | **Edit own replies** |
| Edit or delete other people's discussions | **Edit any discussion**, **Delete any discussion**, or the **Manage discussion** privilege |
| Edit or delete other people's replies | **Manage all replies**, or the **Manage discussion** privilege |

A discussion's **Permissions** can share it with users and groups, with read or write access, as for problems.

### Public and hidden

- A new discussion is public when `discussionDefaultPublic` is on (the default). Making a discussion public or not public needs the **Manage discussion** privilege.
- A new reply is public when `discussionReplyDefaultPublic` is on (the default). With it off, a new reply is seen only by its author and the moderators until a moderator makes it public. On the site, the moderators are administrators and users with the **Manage discussion** privilege; in a team, members with the team's **Discussions** permission (see [Teams](Teams.md)).
- Hiding a reply again works the same way. A hidden reply is never shown to visitors, and approving one in a team discussion doesn't make the team's other content public.

### Keeping order

- Delete spam rather than hiding it; hide replies you want to review first.
- Moderation actions (publishing, hiding, deleting) are recorded in the audit log.
- To stop one user from posting, set **Deny** on **Create discussions and tutorials** and **Reply to discussions** for them; to stop them from seeing discussions at all, **Deny** on **View discussions and tutorials**.
