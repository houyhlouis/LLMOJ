# Two-factor sign-in

[简体中文](Two-Factor-Sign-In.zh-CN.md) | English | [Wiki home](Home.en.md)

Each user can add a second sign-in step to their own account. After the correct password, signing in also asks for one of:

| Second step | What the user needs |
| --- | --- |
| Authenticator code | An authenticator app (Google Authenticator, Microsoft Authenticator, a password manager…) showing a 6-digit code every 30 seconds |
| Passkey | The device's fingerprint, face or screen lock, or a security key. **Passkeys need the site to be opened over HTTPS** (or `localhost`); see [HTTPS](HTTPS.md) |
| Recovery code | One of 10 single-use codes shown when two-factor sign-in is first turned on |

Two-factor sign-in is off for every account until its user turns it on. There is no configuration file setting and nothing to restart.

## Turn it on

1. Sign in, open the user menu → **Edit profile** → **Security**, and find **Two-factor sign-in**.
2. Choose either or both:
   - **Authenticator app → Set up**: scan the QR code (or type the key shown next to it) in the app, enter the 6-digit code it shows, and select **Turn on**.
   - **Passkeys → Add passkey**: optionally rename it, then confirm in the browser's prompt. A passkey works only at the site address where it was added: one added at `https://oj.example.com` doesn't work at another domain or IP address.
3. Save the recovery codes shown once (download or copy them). Only their hashes are stored; **Generate new codes** replaces all of them.

Removing the last authenticator app and passkey turns two-factor sign-in off and removes the recovery codes.

## Signing in

After the password, the login page asks for the second step. A passkey is offered first when the account has one for this site and the browser supports it; **Use an authenticator code** and **Use a recovery code** switch methods. Each authenticator code works once. After five wrong answers you start again from the password, and after ten failures within 15 minutes the account can't complete the second step for a while.

Resetting a forgotten password by email changes the password but still asks for the second step before signing in.

## Confirming sensitive changes

Changing the email address, the password (with two-factor sign-in on, or as a user manager), or two-factor settings requires that the password was entered in this browser session within the last 10 minutes. Otherwise a **Confirm it's you** dialog asks for the password and, with two-factor sign-in on, a second step. This applies to every account: changing the email address always needs it.

## Lost phone, passkeys and recovery codes

A site administrator, or a user with the **Manage user** privilege (who can't do this for administrators), opens the user's **Security** page and selects **Turn off two-factor sign-in**. The user then signs in with the password alone and can set it up again. The action is recorded in the audit log.

## Administration notes

- Authenticator secrets are encrypted with `two-factor.key`, created in the backend's private key directory (`HYHOJ_AI_STATE_DIR`, normally `/opt/LLMOJ/data/ai`) next to the AI `master.key`. `backup.sh` includes this directory. **Restoring a database backup requires the matching `two-factor.key`**: without it, authenticator codes stop working for enrolled users (the backend never silently creates a replacement key). Their passkeys and recovery codes keep working, or an administrator can turn two-factor sign-in off for them.
- The upgrader creates the `user_two_factor` and `user_passkey` tables. It refuses to roll back to a release without two-factor sign-in while any account has it on, because that release would sign those accounts in with the password alone. Turn it off for those accounts first, or repair the new release.
- Passkeys verify the site address the browser reports. Behind a reverse proxy, the public address must be HTTPS; see [HTTPS](HTTPS.md).
