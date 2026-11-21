# Permissions

[简体中文](Permissions.zh-CN.md) | English | [Wiki home](Home.en.md)

This page explains who may do what on an LLMOJ site, and which rule wins when several apply. The server checks every rule; hiding a button in the browser is never what protects anything.

## The layers

| Layer | Where it's set | What it covers |
| --- | --- | --- |
| Site administrators | The `admin` account that the installer creates (and administrators [migrated from old LibreOJ](Environment.md#migrating-from-old-libreoj)); no web page makes anyone an administrator | Everything. Only administrators change other users' permissions and privileges. |
| Permission rules | **Permissions** (`/permissions`, administrators only) | One **Allow** or **Deny** per user and permission, for the [permissions listed below](#all-permissions) |
| Privileges | The user's **Privileges** page, changed by administrators | Seven older, broad privileges: Edit Homepage, Manage user, Manage user group, Manage problem, Manage contest, Manage discussion, Skip human verification |
| An object's own rules | The problem's or discussion's **Permissions**, its owner, whether it's public, and the site's [`preference.security`](Backend-Configuration.md#preferencesecurity) settings | Who may open, edit, delete or share that one problem or discussion |
| Groups | **Groups** (`/groups`) | Sets of users that a problem or discussion can be shared with |
| Teams | The team's own pages (see [Teams](Teams.md)) | The team's private problems, contests, discussions and files |

## Which rule wins

For each check, the first of these that applies decides:

1. **Administrator:** allowed.
2. **A permission rule** for this user and this permission: **Allow** allows and **Deny** refuses, whatever the object's own rules, groups or team roles say.
3. **A privilege** that grants it (for example **Manage problem** for editing any problem): allowed.
4. **The default:**
   - for an action on one problem, discussion, contest or team resource, that object's own rules decide: its owner, whether it's public, the users and groups it's shared with, the team's roles, and the site's `preference.security` settings;
   - for anything else (opening the site, submitting, creating a contest, ...), the default in [the table below](#all-permissions).

Some actions need several permissions, and each must pass: every problem page first needs **View problems**, editing a problem needs viewing it too, and team resources need team access as well as the site's permissions.

**Detailed permission management** is reserved to administrators: no rule or privilege grants it. Changes on the **Permissions** page are recorded in the audit log (`user.set_permissions`).

## Examples

**Sharing a hidden problem with a group.** Bob creates a problem; it's hidden. In its **Permissions** he gives the group *Setters* read access. Carol, a member of *Setters*, can open it; Dave, who isn't, can't.

- An administrator sets **Deny** on **View hidden problems** for Carol: she can no longer open it, although her group has access.
- An administrator sets **Allow** on **View hidden problems** for Erin: she can open every hidden problem, shared with her or not.

**Editing a public problem.** With `preference.security.allowNonPrivilegedUserEditPublicProblem: false`, Bob can't edit his problem once it's public, and neither can users whose groups have write access to it. An **Allow** rule on **Edit own problems** for Bob lets him edit his problems again, public or not; **Allow** on **Edit any problem** lets a user edit any problem they can open.

**A privilege and a rule.** Frank has the **Manage problem** privilege, so he can open, edit and delete every problem and change their permissions and visibility. An administrator sets **Deny** on **Delete any problem** for him: he keeps everything else, but can't delete other people's problems.

**A team permission and a site rule.** Grace has the team permission **Problems** in her team, so the team lets her edit its problems. The site denies her **Edit any problem**: she can still edit team problems she created, but not those of other members. A site-wide **Deny** always applies inside teams, and **Default** gives nothing beyond what the team allows. The site permission **Manage all teams and private resources** lets site staff open every team's private resources.

**Turning a feature off for one user.** **Deny** on **Submit solutions** stops a user from submitting anywhere, in contests too; **Deny** on **Access the site** shuts them out of everything except signing in and out.

## Groups

- **Create groups** is off by default: a user needs an **Allow** rule for it, or the **Manage user group** privilege.
- A group's admins add and remove its members. Renaming or deleting a group, and choosing its admins, need **Manage user group**.
- A problem's or discussion's **Permissions** dialog shares it with users and groups, with read or write access. Only groups the editor can see are listed or accepted.
- Teams have groups of their own, used only inside the team (see [Teams](Teams.md)). They never appear in site-wide permission dialogs, and team resources can't be shared outside the team through them.

## All permissions

**Signed-in users** is the default for a user without a rule; **Visitors** is what someone who isn't signed in may do. For actions on one object, the default leaves the decision to that object's rules (see [Which rule wins](#which-rule-wins)): for example, **View hidden problems** is *Denied* by default, yet a hidden problem's owner and those it's shared with can open it.

| Group | Permission | Key | Signed-in users | Visitors |
| --- | --- | --- | --- | --- |
| Site | Access the site | `ViewSite` | Allowed | Allowed |
| Users and groups | View users and rankings | `ViewUsers` | Allowed | Allowed |
| Users and groups | Edit own profile | `EditOwnProfile` | Allowed | Denied |
| Users and groups | View private user information | `ViewPrivateUserInfo` | Denied | Denied |
| Users and groups | Create groups | `CreateGroup` | Denied | Denied |
| Problems | View problems | `ViewProblem` | Allowed | Allowed |
| Problems | View hidden problems | `ViewHiddenProblem` | Denied | Denied |
| Problems | Create problems | `CreateProblem` | Allowed | Denied |
| Problems | Edit own problems | `EditOwnProblem` | Allowed | Denied |
| Problems | Edit any problem | `EditAnyProblem` | Denied | Denied |
| Problems | Delete own problems | `DeleteOwnProblem` | Allowed | Denied |
| Problems | Delete any problem | `DeleteAnyProblem` | Denied | Denied |
| Problems | Manage problem permissions | `ManageProblemPermissions` | Denied | Denied |
| Problems | Manage problem visibility and IDs | `ManageProblemVisibility` | Denied | Denied |
| Problems | Manage problem tags | `ManageProblemTags` | Denied | Denied |
| Problems | Read problem test data | `ReadProblemData` | Denied | Denied |
| Problems | Edit problem data and judging settings | `EditProblemData` | Allowed | Denied |
| Problems | Download problem attachments | `DownloadProblemAttachments` | Allowed | Allowed |
| Submissions | Submit solutions | `SubmitProblem` | Allowed | Denied |
| Submissions | View submissions | `ViewSubmission` | Allowed | Allowed |
| Submissions | Read all submission code | `ReadAnySubmissionCode` | Denied | Denied |
| Submissions | Read public code after solving | `ReadCodeAfterAccepted` | Denied | Denied |
| Submissions | Rejudge submissions | `RejudgeSubmission` | Denied | Denied |
| Submissions | Delete submissions | `DeleteSubmission` | Denied | Denied |
| Submissions | Invalidate cheating submissions (Fake) | `FakeSubmission` | Denied | Denied |
| Submissions | Run pretest self evaluation in enabled NOI / OI contests | `CreateSelfEval` | Allowed | Denied |
| Hacks | View hack records | `ViewHack` | Allowed | Allowed |
| Hacks | Create hacks | `CreateHack` | Allowed | Denied |
| Hacks | Manage all hacks, references, and validators | `ManageHack` | Denied | Denied |
| Teams | View teams | `ViewTeam` | Allowed | Allowed |
| Teams | Create teams | `CreateTeam` | Allowed | Denied |
| Teams | Manage all teams and private resources | `ManageTeams` | Denied | Denied |
| Discussions | View discussions and tutorials | `ViewDiscussion` | Allowed | Allowed |
| Discussions | Create discussions and tutorials | `CreateDiscussion` | Allowed | Denied |
| Discussions | Edit own discussions | `EditOwnDiscussion` | Allowed | Denied |
| Discussions | Edit any discussion | `EditAnyDiscussion` | Denied | Denied |
| Discussions | Delete own discussions | `DeleteOwnDiscussion` | Allowed | Denied |
| Discussions | Delete any discussion | `DeleteAnyDiscussion` | Denied | Denied |
| Discussions | Reply to discussions | `ReplyDiscussion` | Allowed | Denied |
| Discussions | React to discussions | `ReactDiscussion` | Allowed | Denied |
| Discussions | Edit own replies | `EditOwnReply` | Allowed | Denied |
| Discussions | Manage all replies | `ManageDiscussionReplies` | Denied | Denied |
| Contests | View contests | `ViewContest` | Allowed | Allowed |
| Contests | View hidden contests | `ViewHiddenContest` | Denied | Denied |
| Contests | Create contests | `CreateContest` | Denied | Denied |
| Contests | Edit own contests | `EditContest` | Allowed | Denied |
| Contests | Participate in contests | `ParticipateContest` | Allowed | Denied |
| Contests | View contest scoreboards | `ViewContestScoreboard` | Allowed | Allowed |
| Contests | View hidden scoreboards | `ViewHiddenContestScoreboard` | Denied | Denied |
| Contests | Export contest results | `ExportContest` | Denied | Denied |
| Study lists and summaries | Manage own contest summaries | `ManageSummaries` | Allowed | Denied |
| Study lists and summaries | Manage own private study lists | `ManageStudyLists` | Allowed | Denied |
| AI | Configure own AI and search APIs | `ManageAiConfiguration` | Allowed | Denied |
| AI | Use AI problem tools | `UseAi` | Allowed | Denied |
| AI | Generate test data with AI | `GenerateTestdata` | Allowed | Denied |
| AI | Import problems | `ImportProblem` | Allowed | Denied |
| Administration | Manage registration reviews (including approval after rejection) | `ManageRegistrationReviews` | Denied | Denied |
| Administration | Detailed permission management (administrators only) | `ManagePermissions` | Denied | Denied |

**Read problem test data** works the same way: without a rule, anyone who can open a problem, visitors included, can read its test data, and a **Deny** rule withholds it from a user. Private study lists, contest summaries and AI keys belong to their owners only: no rule or privilege opens them to anyone else.

## See also

- [Teams](Teams.md): team roles, team groups and the team's resources.
- [Registration approval](Registration-Approval.md): **Manage registration reviews**.
- [Fake moderation](Submission-Moderation.md): **Invalidate cheating submissions (Fake)**.
- [AI](AI.md#permissions-and-jobs): the AI permissions.
- [Backend configuration](Backend-Configuration.md#preferencesecurity): the `preference.security` defaults.
