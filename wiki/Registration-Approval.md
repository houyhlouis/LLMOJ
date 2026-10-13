# Registration approval

[简体中文](Registration-Approval.zh-CN.md) | English | [Wiki home](Home.en.md)

Site administrators choose the registration mode in Site management, with saved changes taking effect immediately. Existing active accounts stay active; changing the mode never approves existing pending or rejected applications.

| `registrationMode` | Behavior |
| --- | --- |
| `open` (also the default when omitted) | Registration immediately activates the account |
| `approval` | Registration creates an application; an administrator or authorized reviewer must approve it before login |
| `closed` | No new registrations; existing accounts can still log in and use password recovery with their existing mail configuration |

## Set the mode in the website

1. Sign in as a site administrator and open **Site management** (`/site-management`) from the user menu.
2. Select open, approval-based or closed registration and save. Subsequent requests use the new mode immediately without restarting the backend; refresh an already-open registration page to display the current mode.
3. Select **Restore server configuration** to clear the override and immediately use the YAML value currently loaded by the backend.

Only site administrators (`isAdmin`) can read or change these settings. Ordinary users and accounts granted only `ManageRegistrationReviews` or `EditHomepage` cannot change registration policy. Delegating application reviews does not delegate site configuration.

The override lives in the existing database `settings` table under the independent `registration-policy` key, separate from homepage content. Saving never rewrites `config/backend.yaml`. An absent setting uses YAML; restoring server configuration retains the row with `registrationMode: null`, meaning no override. Precedence is **saved website mode → YAML `preference.security.registrationMode` → `open`**. Restarting or upgrading preserves the database setting, and editing YAML does not supersede an active override.

## Optional server default

To change the fallback, set this field under the **existing** `preference.security` object in `config/backend.yaml` (normally `/opt/LLMOJ/config/backend.yaml`):

```yaml
preference:
  security:
    registrationMode: approval
    # Keep all other existing security preferences.
```

This is a partial example, not a replacement file. Only lowercase `open`, `approval` and `closed` are valid; missing/null defaults to `open`, and an invalid value prevents startup. **Direct YAML edits still require a backend restart to load the new value**; saving or restoring the website setting does not. In a full deployment, also ensure the local judge is running after restarting the backend.

A previous Nginx block on `/api/auth/register` is independent of this setting. Review/remove that rule and validate/reload Nginx when enabling registrations. The updater preserves existing Nginx configuration.

## Review applications

Users register with their username, email and password. Email verification, when enabled, is still required and is separate from approval. Registration stores an independent application with a password hash and displays a waiting message. It creates no site user, consumes no site user ID, and returns no login token. Pending/rejected applications have no public profile or user-list entry.

An administrator or authorized reviewer opens **Registration reviews** from the user menu (`/registration-reviews`), filters pending/approved/rejected/all applications, and approves or rejects pending applications, or approves a previously rejected application, with an optional note of up to 500 characters. The paginated queue uses colored text for status. Only approved entries show a site user ID. Approval creates the complete account and records the decision in one transaction; the new user can then log in with the original password. Rejection records a decision without creating an account.

Site administrators (`isAdmin`) always have review access; ordinary users do not by default. To delegate reviews, an administrator opens **Permissions** (`/permissions`), selects a reviewer account, sets `ManageRegistrationReviews` to **Allow** under Administration, and saves. After refreshing, the reviewer can read applicant emails, internal notes and the queue and make decisions. Set it to **Deny** to revoke access. Group administration or ManageUser alone does not grant review access. Reviewers also need `ViewSite` access, which ordinary users have by default; a site-access denial prevents review even when the review permission is granted.

This grant does not confer administrator status or **Detailed permission management (administrators only)**. Reviewers cannot grant themselves or other users permissions, or edit an administrator's profile/password to take over that account. Permissions live in the database and require no YAML setting or restart. A page refresh may be needed for the menu, while the backend checks current permissions on requests.

Decisions record the reviewer, timestamp and note and are committed together with an audit entry. Notes are visible only to administrators and authorized reviewers; applicants receive a pending/rejected login message. This release does not send automatic decision emails.

## Compatibility and limits

- Existing users and accounts created in `open` mode have no review row and remain active. Site administrator accounts are exempt from the gate.
- Independent pending/rejected applications reserve their username/email but cannot obtain an authenticated identity through login or password reset. Application IDs locate private review records and are not site user IDs.
- Switching back to `open` or restoring the server default does not approve existing pending or rejected applications. Switching to `closed` retains applications and administrators and authorized reviewers may still review them.
- Repeating the same decision does not duplicate accounts or audit entries. Database locks serialize concurrent reviews: approval cannot be reversed, while an application rejected first can subsequently be approved.
- A rejected application can later be approved. Only successful approval creates an account and assigns a new site user ID; a `rejected` → `approved` audit entry preserves the previous rejection history. A username/email conflict fails without changing the application status or creating an account; resolve the conflict before retrying. An approved application cannot return to rejected. Pending/rejected identities remain reserved. There is no reapply or delete-application button; do not remove database rows to bypass history.
- Approval controls account activation. Existing public pages remain accessible to visitors; it is not a site-wide access allowlist.

The current model uses `registration_application` and retains `registration_review` for approved legacy history. No required columns are added to `user`; existing active accounts keep their IDs, passwords and content. Delegated review uses the existing permission tables. The updater only appends `ManageRegistrationReviews` to the known `user_privilege.privilegeType` enum, preserving existing values and their order; it adds no configuration or business table.

Upgrading from the first approval release requires the new updater, not just replacing the frontend or restarting the backend. It backs up the database and tests migration on a clone. Old pending/rejected empty accounts become independent applications, retaining their password hashes, timestamps and review details; their unused account records are then removed. Later approval allocates a new site user ID. Historical IDs are never recycled and gaps remain. Normal registration/wrong-password audit rows owned by the empty account are archived in full inside private application data and are never returned by the API; administrator review logs remain and are linked to the application.

Only inactive accounts matching the original default registration data and having no business content or custom privileges are eligible. Submissions, problems, discussions, custom profiles, permissions, unknown references, cross-database foreign keys or application identity conflicts cause migration to stop while preserving the original data. Existing approved accounts keep their IDs.

After application data migration, restoring older code that ignores applications can be unsafe. A failed cutover may leave application services stopped; retain the new data model and repair the deployment, as described in [Upgrade and recovery](Upgrade.md). If the table is missing, check migration output. If the menu is missing, verify administrator status or a `ManageRegistrationReviews` grant and that both frontend and backend were updated, then refresh the browser.
