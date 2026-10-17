# Registration approval

[简体中文](Registration-Approval.zh-CN.md) | English | [Wiki home](Home.en.md)

A site has one of three registration modes:

| Mode | `registrationMode` | What happens when someone registers |
| --- | --- | --- |
| Open registration | `open` (the default) | The account is active at once |
| Administrator approval | `approval` | An application is created; the person can sign in only after it's approved |
| Registration closed | `closed` | Nobody can register; existing accounts still sign in and recover passwords as usual |

Changing the mode never affects existing accounts, and never approves pending or rejected applications.

## Choosing the mode

1. Sign in as a site administrator and choose **Site management** (`/site-management`) in the user menu.
2. Choose a **Registration mode** and click **Save**. The new mode applies to the next request, with no restart; refresh a registration page that's already open to see it.
3. To go back to the mode in the server's configuration file, click **Restore server configuration**.

Only site administrators can change the mode. Users who may review applications or edit the homepage can't.

The mode saved here is stored in the database and survives restarts and upgrades. It takes precedence over `config/backend.yaml`; if none is saved, the file's value is used, and if the file has none, registration is open.

### Default in the configuration file

To change the server's default, add `registrationMode` to the **existing** `preference.security` section of `config/backend.yaml` (normally `/opt/LLMOJ/config/backend.yaml`):

```yaml
preference:
  security:
    registrationMode: approval
    # keep the other settings already here
```

Valid values are `open`, `approval` and `closed`, in lower case; any other value stops the backend from starting. Restart the backend after editing the file. A mode saved in **Site management** still takes precedence.

If you blocked `/api/auth/register` in Nginx at some point, that block still applies whatever the mode is. Remove it and reload Nginx when you want to allow registrations; upgrades don't change your Nginx configuration.

## Reviewing applications

People register with a username, email address and password. If the site requires email verification, they still verify their address first. Registering then creates an application, not an account: the person has no user ID, can't sign in, and doesn't appear in the user list.

To review, choose **Registration reviews** (`/registration-reviews`) in the user menu. Filter by status (**Pending**, **Approved**, **Rejected** or all), then **Approve** or **Reject** each application, with an optional note of up to 500 characters.

- **Approving** creates the account and gives it a user ID; the person signs in with the password they registered with.
- **Rejecting** creates no account. A rejected application can be approved later; an approved one can't be rejected.
- If the username or email has been taken in the meantime, approval fails and the application stays as it was. Resolve the conflict and try again.

Notes are visible only to reviewers. Applicants who try to sign in are told that their application is pending or was rejected. No email is sent when an application is decided.

Pending and rejected applications keep their username and email reserved. There's no way to reapply or delete an application, so that the history is kept; don't delete database rows to get round this.

Approval controls only who gets an account. Pages that visitors can see stay visible to visitors.

## Letting others review

Site administrators can always review. To let another user review:

1. Open **Permissions** (`/permissions`) and choose the user.
2. Under **Administration**, set **Manage registration reviews (including approval after rejection)** to **Allow**, then click **Save permissions**.

After refreshing the page, the reviewer sees **Registration reviews**, including applicants' email addresses and notes. Set the permission to **Deny** to take it away. Managing users or groups doesn't include reviewing, and a user who is denied access to the site can't review either.

Reviewers don't become administrators: they can't change permissions, or the profile or password of an administrator.

Every decision records the reviewer, the time and the note, and is written to the audit log.

## Upgrading

Accounts that existed before approval was introduced, and accounts created in open mode, are simply active.

The [upgrader](Upgrade.md) adds the `registration_application` table and appends `ManageRegistrationReviews` to the list of permissions, keeping existing values in order. Use the upgrader rather than replacing files or restarting by hand.

When upgrading from the first release with registration approval, the upgrader turns old pending and rejected accounts into applications, keeping their password hashes, dates and review details, and removes the empty accounts. It first tests this on a copy of the database, and stops without changing anything if any such account has content (submissions, problems, discussions, permissions or a custom profile) or a conflicting username or email. Approved accounts keep their IDs. User IDs aren't reused, so the list of IDs may have gaps.

After this migration, don't go back to code that predates applications. If the upgrade fails at that point, the upgrader may leave the site stopped to protect the applications; keep the new data and repair the installation as described in [Upgrade and recovery](Upgrade.md).

## Troubleshooting

- **No Registration reviews in the menu:** check that the account is an administrator or has the review permission, and refresh the page. If the old page still appears, check that both the frontend and the backend were upgraded.
- **The backend reports a missing table:** read the upgrade log for the database migration. Don't work round it by turning off AppArmor, loosening directory permissions or deleting the old database.
