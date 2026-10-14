# Teams

[简体中文](Teams.zh-CN.md) | English | [Wiki home](Home.en.md)

Open your own profile and click **My teams** (`/teams`) to create a team or view your joined teams and pending applications. Teams do not appear in the top navigation, a public directory, or another user’s profile. Enter the numeric **Team ID** supplied by its owner, confirm the team name and join policy, and explicitly join or apply. Before admission, only that confirmation information and your own application are visible; descriptions, announcements, member lists and resources stay private. The interface uses the existing OJ theme, Markdown renderer, problem editor, discussions and contest pages.

## Membership and invitations

The creator becomes the owner. A team has a name, description, announcement and an approval-free, approval-required or invitation-only join policy. Approval-free admission still requires the team ID or invitation; it never publishes the team. Applications include a message and can be approved or rejected by member managers. Pending applicants can see and withdraw only their own application. Knowing the ID does not allow browsing private content.

Member managers can issue shared or user-specific invitations with a usage limit and expiry, and deactivate them. `/team-invite/<token>` requires an explicit acceptance after sign-in; merely opening the link does not join the team. Blocked users cannot bypass the blacklist with an invitation.

Members can leave. Owners must transfer ownership to an existing member before leaving. Removal or departure revokes access to private team content.

## Groups and permissions

The members page provides search, group/status filters, batch review and removal, notes, blacklisting and batch grouping. Team notes appear in assignment results and exports without changing site usernames.

Only the owner or a user authorized by the site-wide **Manage all teams and private resources** permission assigns team management permissions:

| Permission | Scope |
| --- | --- |
| Settings | Name, description, announcement and join policy |
| Members | Review, removal, notes, groups and invitations |
| Problems | Create, copy, edit and manage problem data |
| Contests | Create/edit contests and control visibility |
| Assignments | Create/edit/archive lists and export scores |
| Discussions | Moderate team discussions |
| Files | Archive or restore team files |

Member managers cannot promote themselves or transfer ownership. The site Permissions page separately controls **View teams**, **Create teams**, and **Manage all teams and private resources**. Viewing permits access to your own teams and joining by ID; it does not expose other teams. Viewing and creation are enabled by default; global management is privileged and disabled by default. Global management grants access to private team resources, while ordinary membership and team managers remain scoped to their own teams. Team permissions grant no site-wide administrator status and cannot bypass site bans on access, submissions, discussions or participation. Internal authorization groups are excluded from ordinary group-management endpoints.

Members may change their own group unless that option is locked. Managers can create, rename and archive groups, and assign members in batches.

## Resources

Create a blank team problem or copy one that you have permission to edit. Copying preserves statements, locales, samples, judge settings, test data and attachments without changing the source problem. The existing problem and file editors remain available, and members submit through the usual problem page.

Contests support NOI / OI, IOI, ICPC and Strict IOI. Internal contests require membership. Public contests follow site contest permissions. Invitation contests accept named users or a shared `/contest-invite/<token>` link; accepting a contest invitation does not join its team. Contest timing, scoring, submission, code and scoreboard restrictions still apply. [Hack](Hacks.md) follows the contest settings. [Self-evaluation](Self-Evaluation.md) is an optional feature of NOI / OI contests only and defaults to disabled.

Team discussions reuse the existing discussion and reply system. Lists and direct links both enforce membership: a public flag, an old author identity or knowledge of a URL cannot expose private team content. [Solutions](Solutions.md) remain a category of discussion.

Problems, contests, discussions and assignments can be archived and restored. Archived resources are hidden from ordinary members; authorized managers can restore them through **Show archived**. Archiving an entire team retains its content and can be reversed by its owner or an authorized global team manager.

## Study lists and assignments

Build an ordered list with sections and per-problem notes. Leave the deadline empty for a study list, or specify a deadline for an assignment. Assign it to individual members, groups or the whole team. Results show each member's best score per problem and total, with CSV export.

Deadline-based assignments count ordinary submissions made at or before the deadline; contest submissions do not count. Fake and Hacked submissions earn zero and cannot contribute an accepted result. Access to assignment scores does not grant permission to read other members' code. Exports include team notes and escape spreadsheet-formula content.

## Files

Members can upload/download files; file managers can archive or restore them. Each team has **10 GiB total space**, with **no separate per-file size limit**. A file may use all remaining space. Archived files remain stored and continue to use quota.

Large files upload automatically in 32 MiB chunks; the storage server combines them without loading the entire file into application memory. This keeps existing proxy and non-team upload limits unchanged. The server reserves space before uploading, checks permissions again for each chunk and completion, and verifies the actual stored bytes. Concurrent uploads and forged size declarations cannot exceed the total quota. Failed or cancelled uploads release their reservations; interrupted sessions expire after 24 hours, and unused chunks are cleaned up. Existing teams receive the same 10 GiB quota through the supported upgrade.

Membership is checked before issuing a download URL; a previously issued URL may remain usable for up to 60 seconds after departure, but no new URL can be obtained.

These are local LLMOJ team workflows, without Luogu paid services, training benefits or external RemoteJudge integration. Existing deployments must follow [Community upgrade](Community-Upgrade.md).
