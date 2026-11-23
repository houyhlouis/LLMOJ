# Using the API

[简体中文](API.zh-CN.md) | English | [Wiki home](Home.en.md)

Everything the website does goes through the backend's HTTP API, so scripts can do the same: list problems, submit, follow judging, export results. This page describes the conventions every endpoint shares. For who may call what, see [Permissions](Permissions.md).

## Endpoints and their description

- Endpoints are `https://<your site>/api/<module>/<action>`, for example `/api/problem/queryProblemSet`. Almost all are `POST` with a JSON body (`Content-Type: application/json`) and a JSON answer; a few reads are `GET`.
- The backend describes every endpoint, its request and its answer in OpenAPI: the page `/docs` and the document `/docs-json` on the backend itself. An installation's Nginx passes only `/api/` on, so open them on the server (`http://127.0.0.1:2002/docs`, or through an SSH tunnel), or on a [development stack](Development.md).
- The website's TypeScript client is generated from that description, in `packages/frontend/src/api-generated` (`types.d.ts` has every request and answer type). After changing the backend's API, regenerate it with `node packages/frontend/scripts/generate-api.js --from-backend-build` once the backend is built.

## Signing in

1. `POST /api/auth/login` with `{"username": "...", "password": "..."}` (or `"email"` instead of `"username"`). It needs a [proof of work](#proof-of-work-and-human-verification).
2. The answer has a `token`. Send it with every later request: `Authorization: Bearer <token>`.
3. An account with [two-factor sign-in](Two-Factor-Sign-In.md) gets a `twoFactorChallenge` instead. `POST /api/twoFactor/completeLogin` with that `challenge` and a `totpCode` from the authenticator app (or a `recoveryCode`) then gives the token.
4. `POST /api/auth/logout` ends the session. The site may also end it (it expired, was signed out elsewhere or revoked): an answer then has the header `X-Session-Ended: 1`, and the request was handled as a visitor's. Sign in again.

The website's own pages, on the API's origin, keep their session in an HttpOnly cookie instead (they send `X-Session-Mode: cookie`, and get a marker `cookie:<session ID>` that is no credential). Scripts and pages on other origins always use the token. A token is a full session of the account: keep it secret, and use an account with only the permissions the script needs.

Some changes (a password or email address, two-factor settings, ...) need a recent password entry: the answer is the error `REAUTHENTICATION_REQUIRED`, and nothing was changed. Confirm the password as described in [Confirming sensitive changes](Two-Factor-Sign-In.md#confirming-sensitive-changes), then send the request again.

## Proof of work and human verification

Requests that cost the site something (signing in, registering, sending email codes, resetting a password, creating a problem or adding a file to one, preparing an answer file upload, submitting, creating a discussion or reply) need a proof of work:

1. `POST /api/proofOfWork/issueChallenge` with `{"action": "submit_problem"}` (the action of the request; the generated client names them). The answer has an `id`, `randomData`, a `difficulty` and `expiresAt`.
2. Find a number `nonce` (0, 1, 2, ...) for which the SHA-256 of `randomData` followed by the nonce in decimal, written as hexadecimal, starts with `difficulty` zeros.
3. Send the request with the header `X-Proof-Of-Work: {"id": "...", "nonce": 12345, "response": "<the hexadecimal hash>"}`.

A challenge works once, for one action, from the address (and session) it was issued to, for 5 minutes. A client can get at most 20 challenges in 10 seconds. The difficulty is `security.proofOfWork.difficulty` (submitting has `expensiveActionDifficulty`) in the [backend configuration](Backend-Configuration.md). When the site has human verification on, submitting also needs the header `X-Captcha-Result`, which scripts can't produce.

Accounts with the privilege **Skip human verification** (set by an administrator on the account's **Privileges** page) need neither. Give it to a dedicated account for robots and virtual judges, not to people.

## Answers and errors

- **Success:** HTTP 200 or 201 with a JSON answer.
- **Expected failures** are part of the answer, with HTTP 200 or 201: `{"error": "NO_SUCH_PROBLEM"}`, `{"error": "PERMISSION_DENIED"}` and so on. The generated client lists each endpoint's codes.
- **HTTP errors:** 400 for a malformed request (the body names the invalid fields), 403 when a site permission or a proof of work refuses it, 404, 409 when the request conflicts with a change made at the same time (send it again), 429 when the address sent too many requests (`security.rateLimit`: 200 in 10 seconds by default), and 500 for a server failure:
  - `{"error": "INTERNAL_ERROR", "requestId": "..."}` for an unexpected failure.
  - `{"error": "LOCK_LEASE_LOST", "requestId": "..."}` when an operation lost the Redis lock that protected it (Redis became unreachable, slow, restarted or evicted the lock, or the backend process paused past the lock's lease). Nothing the operation would have written after the loss is written; a step it completed before the loss may have been saved, so reload the resource before retrying.
- **Request IDs:** every answer has an `X-Request-Id` header, and a server error repeats it in its body. Quote it when you report a problem: the server's log line for the request has the same ID.

## Pages of results

Lists are read in pages: `skipCount` (how many to skip) and `takeCount` (how many to return), with an upper limit per endpoint (`queryLimit` in the backend configuration; a larger `takeCount` is refused). Answers give the total `count` where the endpoint has one. Contest lists use `page` instead, 50 rows each. Results change while you read: to read everything, go by ID ranges or filters, not by page numbers alone.

## Uploading files

Files (answer archives, test data, attachments, team files) never pass through the backend. Each upload takes three steps:

1. Call the endpoint with `uploadInfo: {"size": <bytes>, "uuid": null}` (some endpoints have a separate prepare call, such as `submission/prepareFileUpload`). The answer has a `signedUploadRequest`: `method`, `url`, `extraFormData`, `fileFieldName` and the upload's `uuid`.
2. Send the file to that `url`: for `POST`, as a multipart form with the `extraFormData` fields and the file in `fileFieldName`. The form works for 10 minutes and accepts exactly the declared size.
3. Call the endpoint again with `uploadInfo: {"size": <bytes>, "uuid": "<the upload's uuid>"}`.

In step 3 the backend copies the uploaded object to one that no form can write, checks its size and records its SHA-256, and only then registers the file with the change. `FILE_NOT_UPLOADED` means the upload isn't there (expired or not sent), and a size that doesn't match is refused.

## Following judging live

Submission pages update live through Socket.IO 4:

- Connect to the site's address with path `/api/socket`, namespace `/submission-progress`, transport `websocket` only, and the [msgpack parser](https://github.com/socketio/socket.io-msgpack-parser).
- The handshake query has `subscriptionKey`: the `progressSubscriptionKey` that `submission/querySubmission` and `submission/getSubmissionDetail` return while submissions are being judged. A key belongs to the account and session that got it, and works for 24 hours.
- The server sends `message` events with a submission ID and a [jsondiffpatch](https://github.com/benjamine/jsondiffpatch) delta against the previous message for that submission on this connection; the first one for a submission is against nothing. Permissions are checked again before every message.
- **After a disconnection**, a new connection starts over: each submission's first message is complete again, so apply deltas only within one connection. When the server closes the connection itself (it no longer accepts the key, for example after signing out), don't retry with the same key: read the submissions through the API again, which gives a fresh key while they're still being judged.

The `/judge` namespace on the same path is for [judge machines](Distributed-Judging.md), not for clients.

## An example

With `curl` and a token from signing in:

```bash
curl -s https://oj.example.com/api/problem/queryProblemSet \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"locale": "en_US", "skipCount": 0, "takeCount": 20}'
```

The answer lists the problems this account can see, and `count`. To try requests without touching a real site, start a [development stack](Development.md) and use its backend.
