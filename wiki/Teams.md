# Teams

[简体中文](Teams.zh-CN.md) | English | [Wiki home](Home.en.md)

Teams are private. Open your own profile and click **My teams** (`/teams`) to create a team, or to see the teams you belong to and your pending applications. Teams don't appear in the top navigation, in a public list or on other users' profiles. To join one, enter the **Team ID** its owner gives you, check the team's name and how it admits members, then join or apply. Until you're a member you see only that and your own application, not the team's description, announcements, members or resources.

## Joining and invitations

Whoever creates a team becomes its owner. A team has a name, description, announcement and one of three ways to admit members:

| Admission | What happens |
| --- | --- |
| Open | Any signed-in user who knows the team ID joins after confirming; the team stays private |
| Approval | Applicants write a message, and a member manager approves or rejects it |
| Invitation only | Applications aren't accepted; people join with a valid invitation |

While an application is pending, the applicant can see or withdraw only their own application. Knowing a team's ID never shows its private content.

Member managers can create invitations for anyone or for specific users, with a usage limit and an expiry date, and can deactivate them. An invitation link (`/team-invite/<token>`) doesn't add you just by opening it: sign in and click **Accept invitation**. Blocked users can't rejoin with an invitation.

Members can leave a team; the owner must first transfer ownership to another member. Removed or departed members lose access to the team's private content.

## Members, groups and permissions

The members page has search, group and status filters, batch approval and removal, blocking, notes and batch group changes. Team notes appear in assignment results and exports; they don't change anyone's username.

The owner, or a user with the site-wide **Manage all teams and private resources** permission, grants these team permissions:

| Permission | Allows |
| --- | --- |
| Settings | Changing the name, description, announcement and admission |
| Members | Reviewing applications, removing members, notes, groups and invitations |
| Problems | Creating, copying and editing team problems and their data |
| Contests | Creating and editing team contests and choosing who can enter |
| Assignments | Creating, editing, archiving and exporting assignments |
| Discussions | Moderating team discussions |
| Files | Archiving and restoring team files |

Member managers can't grant themselves permissions or transfer ownership.

On the site's **Permissions** page, **View teams**, **Create teams** and **Manage all teams and private resources** are separate. Viewing lets users use their own teams and join by ID; it never shows other teams. Viewing and creating are allowed by default; managing all teams is off by default and gives access to every team's private resources. Team permissions apply only inside the team: they don't make anyone a site administrator or lift a site-wide ban on access, submitting, discussing or entering contests.

Member managers can create, rename and archive groups and move members between them. Unless the group choice is locked, members can pick their own group.

## Problems, contests and discussions

In a team's **Problems**, create a blank problem, or copy one you can edit. A copy includes the statement in every language, samples, judge settings, test data and attachments; the original isn't changed. Team problems are edited with the usual problem and file editors, and members submit on the usual problem page.

Team contests can use NOI / OI, IOI, ICPC or Strict IOI rules, and are internal, public or by invitation:
- **Internal:** members only.
- **Public:** follows the site's contest permissions.
- **By invitation:** named users, or anyone with a shared `/contest-invite/<token>` link. Accepting a contest invitation gives access to that contest only, not to the team.

The contest's own timing, scoring and rules about code, submissions and scoreboards still apply. [Hacks](Hacks.md) follow the contest's settings; [Self Eval](Self-Evaluation.md) is an option of NOI / OI contests and is off by default.

Team discussions work like site discussions, and every list and link checks team membership: marking a discussion public, having written it in the past, or knowing its link doesn't reveal it to non-members. [Solutions](Solutions.md) are discussions too.

Problems, contests, discussions and assignments can be archived and restored. Archived items are hidden from ordinary members; managers restore them through **Show archived**. A whole team can be archived with all its content, and its owner or a site-wide team manager can restore it.

## Study lists and assignments

Build an ordered list of problems, with sections and a note for each problem. Without a deadline it's a study list; with one it's an assignment. Assign it to members, groups or the whole team. The results show each member's best score per problem and their total, and can be exported as CSV.

Results follow the site's permissions, as the submission list does. Without the permission to view submissions, an assignment shows no results, in its export too. A problem you can't view shows as unavailable, without its title or results, and doesn't count towards totals. In the team's problem, contest and discussion lists, items you can't open show **Unavailable to you** instead of their titles: being in a team never lifts a site-wide denial.

For an assignment, only ordinary submissions made by the deadline count; contest submissions don't. Fake and Hacked submissions score 0 and never count as accepted. Seeing assignment results doesn't let anyone read other members' code. Exports include team notes, and content that a spreadsheet could treat as a formula is escaped.

## Files

Members can upload and download team files; file managers can archive and restore them. Each team has **10 GiB in total and no limit per file**, so one file can use all the remaining space. Archived files are kept and still count toward the space.

Large files upload automatically in 32 MiB parts, which the storage server joins, so other upload limits stay unchanged. Space is reserved before an upload starts, permissions are checked again for each part and at the end, and the stored size is verified, so neither simultaneous uploads nor a false file size can exceed the space. A failed or canceled upload releases its reservation; an interrupted upload expires after 24 hours and its parts are cleaned up.

Downloads check membership each time. A download link already issued keeps working for up to 60 seconds after a member leaves, but they can't get a new one.

Installations from before teams existed need the database changes in [Feature upgrades](Community-Upgrade.md).
