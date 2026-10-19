/* Sign-in sessions kept in an HttpOnly cookie (session-cookie.ts): a page of the API's own origin that asks for it gets
   the cookie and a marker of its session instead of the token; the cookie authenticates reading from the same origin,
   and changes only with the session mode header; JSONP, other origins and other sites never use it. Storage is
   stubbed. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { AuthSessionService, RegistrationReviewService, controller } = require("./registration-test-helpers.cjs");
const { AuthMiddleware } = require("./auth.middleware.ts");
const cookie = require("./session-cookie.ts");

const secret = "synthetic-session-test-secret";
const member = { id: 2, isAdmin: false };
const token = jwt.sign("2 9", secret);
const approved = new RegistrationReviewService({ manager: { findOneBy: async () => null } });

/** A request as Express gives it, with the response that collects `Set-Cookie`. */
function request({ method = "POST", headers = {}, query = {}, secure = false } = {}) {
  const cookies = [];
  const res = { append: (name, value) => (assert.equal(name, "Set-Cookie"), cookies.push(value)) };
  return { method, headers: { host: "oj.example", ...headers }, query, secure, ip: "127.0.0.1", res, cookies };
}
const page = (extra = {}) => ({ "sec-fetch-site": "same-origin", "x-session-mode": "cookie", ...extra });

function sessions(security = {}) {
  const redis = {
    defineCommand() {},
    async callSessionManager(...args) {
      if (args[0] === "new") return 9;
      return args[0] === "access" ? 1 : [];
    },
    async set() {}
  };
  return new AuthSessionService(
    { config: { security: { sessionSecret: secret, ...security } } },
    { findUserById: async id => (id === 2 ? member : null) },
    { getClient: () => redis },
    approved
  );
}

test("the cookie and the header are read as sent; a page's marker is no credential", () => {
  assert.equal(cookie.cookieSessionKey({ headers: { cookie: `a=1; llmoj_session=${token}; b=2` } }), token);
  assert.equal(cookie.cookieSessionKey({ headers: { cookie: "llmoj_session=a%2Bb" } }), "a+b");
  assert.equal(cookie.cookieSessionKey({ headers: { cookie: "llmoj_session=" } }), null);
  assert.equal(cookie.cookieSessionKey({ headers: { cookie: "xllmoj_session=1; other=2" } }), null);
  assert.equal(cookie.cookieSessionKey({ headers: {} }), null);
  assert.equal(cookie.bearerSessionKey({ headers: { authorization: `Bearer ${token}` } }), token);
  assert.equal(cookie.bearerSessionKey({ headers: { authorization: "Bearer cookie:9" } }), null);
  assert.equal(cookie.sessionMarker(9), "cookie:9");
  assert.ok(cookie.isSessionMarker("cookie:9") && !cookie.isSessionMarker(token));
});

test("same origin: as the browser says, else the Origin must name this host", () => {
  const same = headers => cookie.isSameOriginRequest({ headers: { host: "oj.example", ...headers } });
  assert.equal(same({ "sec-fetch-site": "same-origin" }), true);
  for (const site of ["same-site", "cross-site", "none"]) assert.equal(same({ "sec-fetch-site": site }), false, site);
  // The browser's word counts even if the Origin looks right
  assert.equal(same({ "sec-fetch-site": "cross-site", origin: "https://oj.example" }), false);
  assert.equal(same({ origin: "https://oj.example" }), true);
  assert.equal(same({ origin: "http://OJ.example" }), true);
  assert.equal(same({ origin: "https://evil.example" }), false);
  assert.equal(same({ origin: "https://oj.example.evil" }), false);
  assert.equal(same({ origin: "null" }), false);
  assert.equal(same({ origin: "https://public.example", host: "127.0.0.1:2002", "x-forwarded-host": "public.example" }), true);
  // Neither header: not a page of another site
  assert.equal(same({}), true);
});

test("the cookie reads from the same origin, and changes only with the session mode header", () => {
  const allowed = (method, headers, query) => cookie.cookieSessionAllowed({ method, headers: { host: "oj.example", ...headers }, query });
  assert.equal(allowed("GET", { "sec-fetch-site": "same-origin" }), true);
  assert.equal(allowed("GET", { "sec-fetch-site": "cross-site" }), false);
  assert.equal(allowed("GET", { "sec-fetch-site": "same-origin" }, { jsonp: "1" }), false);
  assert.equal(allowed("POST", page()), true);
  assert.equal(allowed("POST", { "sec-fetch-site": "same-origin" }), false, "without the header");
  assert.equal(allowed("POST", { "x-session-mode": "cookie" }), true, "an older browser on the same origin");
  assert.equal(allowed("POST", { "x-session-mode": "cookie", origin: "https://evil.example" }), false);
  assert.equal(allowed("POST", page({ "sec-fetch-site": "same-site" })), false);
  assert.equal(cookie.wantsCookieSession({ headers: { host: "oj.example", ...page() } }), true);
  assert.equal(cookie.wantsCookieSession({ headers: { host: "oj.example", "sec-fetch-site": "same-origin" } }), false);
  assert.equal(cookie.wantsCookieSession({ headers: { host: "oj.example", ...page({ "sec-fetch-site": "cross-site" }) } }), false);
});

test("the cookie is HttpOnly and SameSite=Strict, Secure over HTTPS, and lasts as long as a session can", () => {
  const set = (req, days) => cookie.sessionCookie({ headers: {}, secure: false, ...req }, "k", days).split("; ");
  assert.deepEqual(set({}, 90), ["llmoj_session=k", "Path=/", `Max-Age=${90 * 86400}`, "HttpOnly", "SameSite=Strict"]);
  assert.ok(set({ secure: true }, 90).includes("Secure"));
  assert.ok(set({ headers: { "x-forwarded-proto": "https" } }, 90).includes("Secure"));
  assert.ok(!set({ headers: { "x-forwarded-proto": "http" } }, 90).includes("Secure"));
  // Behind a chain of proxies the last one may say http; the page's origin tells
  assert.ok(set({ headers: { "x-forwarded-proto": "http", origin: "https://oj.example" } }, 90).includes("Secure"));
  assert.ok(!set({ headers: { origin: "http://oj.example" } }, 90).includes("Secure"));
  assert.ok(set({}, 0).includes(`Max-Age=${400 * 86400}`), "no limit: as long as browsers keep cookies");
  assert.ok(set({}, 1000).includes(`Max-Age=${400 * 86400}`));
  assert.deepEqual(cookie.expiredSessionCookie({ headers: {}, secure: false }).split("; ").slice(0, 3), ["llmoj_session=", "Path=/", "Max-Age=0"]);
});

test("signing in from a page of the same origin sets the cookie and gives the page a marker", async () => {
  const req = request({ headers: page() });
  const kept = await sessions().issueSession(member, req);
  assert.equal(kept, "cookie:9");
  assert.equal(req.cookies.length, 1);
  assert.match(req.cookies[0], /^llmoj_session=[^;]+; Path=\/; Max-Age=7776000; HttpOnly; SameSite=Strict$/);
  const sent = decodeURIComponent(req.cookies[0].split(";")[0].split("=")[1]);
  assert.deepEqual(jwt.verify(sent, secret), "2 9");
  // The configured session age, and Secure behind an HTTPS proxy
  const https = request({ headers: page({ "x-forwarded-proto": "https" }) });
  await sessions({ sessionMaxAgeDays: 7 }).issueSession(member, https);
  assert.match(https.cookies[0], /Max-Age=604800; HttpOnly; SameSite=Strict; Secure$/);
});

test("anything else gets the session token, as before", async () => {
  for (const [why, req, security] of [
    ["no session mode header", request({ headers: { "sec-fetch-site": "same-origin" } })],
    ["another origin", request({ headers: page({ "sec-fetch-site": "cross-site" }) })],
    ["cookies turned off", request({ headers: page() }), { sessionCookie: false }]
  ]) {
    const kept = await sessions(security).issueSession(member, req);
    assert.equal(jwt.verify(kept, secret), "2 9", why);
    assert.deepEqual(req.cookies, [], why);
  }
});

async function through(req, resolved = { sessionId: 9, user: member }, service = {}) {
  const headers = {};
  const forgotten = [];
  const middleware = new AuthMiddleware(
    { resolveSession: async key => (key === token ? resolved : { ended: true }), forgetSessionCookie: r => forgotten.push(r), ...service },
    {}
  );
  await new Promise(resolve => middleware.use(req, { setHeader: (name, value) => (headers[name] = value) }, resolve));
  return { session: req.session, headers, forgotten: forgotten.length };
}

test("the middleware takes the header first, then the cookie when the request may use it", async () => {
  const withCookie = (extra = {}) => ({ cookie: `llmoj_session=${encodeURIComponent(token)}`, ...extra });
  let r = await through(request({ headers: withCookie(page()) }));
  assert.equal(r.session.user, member);
  assert.equal(r.session.viaCookie, true);
  assert.equal(r.session.sessionKey, token);
  // A page's marker in the header doesn't hide the cookie
  r = await through(request({ headers: withCookie(page({ authorization: "Bearer cookie:9" })) }));
  assert.equal(r.session.viaCookie, true);
  // A token in the header comes first
  r = await through(request({ headers: withCookie({ authorization: `Bearer ${token}` }) }));
  assert.equal(r.session.viaCookie, false);
  // Requests that may not use the cookie continue as a visitor's, and the session isn't consulted
  for (const [why, req] of [
    ["a change without the header", request({ headers: withCookie({ "sec-fetch-site": "same-origin" }) })],
    ["another site", request({ headers: withCookie(page({ "sec-fetch-site": "cross-site" })) })],
    ["another origin", request({ headers: withCookie({ "x-session-mode": "cookie", origin: "https://evil.example" }) })],
    ["JSONP", request({ method: "GET", headers: withCookie({ "sec-fetch-site": "same-origin" }), query: { jsonp: "1" } })]
  ]) {
    r = await through(req, undefined, { resolveSession: async () => assert.fail(`${why}: consulted the session`) });
    assert.equal(r.session, undefined, why);
  }
  // Reading needs no header
  r = await through(request({ method: "GET", headers: withCookie({ "sec-fetch-site": "same-origin" }) }));
  assert.equal(r.session.user, member);
});

test("an ended cookie session is reported and its cookie removed", async () => {
  const r = await through(request({ headers: { cookie: "llmoj_session=revoked", ...page() } }));
  assert.equal(r.session, undefined);
  assert.equal(r.headers["X-Session-Ended"], "1");
  assert.equal(r.forgotten, 1);
  // An ended header session keeps the cookie as it is
  const header = await through(request({ headers: { authorization: "Bearer revoked", cookie: "llmoj_session=x", ...page() } }));
  assert.equal(header.headers["X-Session-Ended"], "1");
  assert.equal(header.forgotten, 0);
});

function auth(sessionService) {
  return controller({
    authSessionService: sessionService,
    auditService: { log: async () => {} },
    configService: { preferenceConfigToBeSentToUser: { security: {} } },
    registrationSettings: { getRegistrationMode: async () => "open" },
    userService: { getUserMeta: async user => ({ id: user.id }), getUserPreference: async () => ({}) },
    groupService: { getUserJoinedGroupsCount: async () => 0 },
    userPrivilegeService: { getUserPrivileges: async () => [] }
  });
}

test("signing out ends the session and removes the cookie", async () => {
  const service = sessions();
  const ended = [];
  service.endSession = async key => ended.push(key);
  const req = request({ headers: { cookie: `llmoj_session=${token}`, ...page() } });
  req.session = { sessionKey: token, sessionId: 9, viaCookie: true, user: member };
  assert.deepEqual(await auth(service).logout(member, req), {});
  assert.deepEqual(ended, [token]);
  assert.match(req.cookies[0], /^llmoj_session=; Path=\/; Max-Age=0/);
  // Without a cookie there is nothing to remove
  const header = request({ headers: { authorization: `Bearer ${token}` } });
  header.session = { sessionKey: token, sessionId: 9, user: member };
  await auth(service).logout(member, header);
  assert.deepEqual(header.cookies, []);
});

test("a page that signed in before moves its session into the cookie", async () => {
  const service = sessions();
  const move = async (headers, session, security) => {
    const req = request({ headers });
    req.session = session;
    const result = await auth(security ? sessions(security) : service).moveSessionToCookie(session?.user, req);
    return { result, cookies: req.cookies };
  };
  const headerSession = { sessionKey: token, sessionId: 9, user: member };
  let r = await move(page({ authorization: `Bearer ${token}` }), headerSession);
  assert.deepEqual(r.result, { token: "cookie:9" });
  assert.match(r.cookies[0], /^llmoj_session=.+HttpOnly; SameSite=Strict$/);
  // Nothing changes for another origin, without the header, for a cookie session, signed out, or with cookies off
  for (const [why, headers, session, security] of [
    ["another origin", page({ "sec-fetch-site": "cross-site" }), headerSession],
    ["no header", { "sec-fetch-site": "same-origin" }, headerSession],
    ["already a cookie session", page(), { ...headerSession, viaCookie: true }],
    ["signed out", page(), undefined],
    ["cookies off", page(), headerSession, { sessionCookie: false }]
  ]) {
    r = await move(headers, session, security);
    assert.deepEqual(r.result, {}, why);
    assert.deepEqual(r.cookies, [], why);
  }
});

test("page loads learn the marker of a cookie session, and only of one", async () => {
  const service = sessions();
  const info = async (query, session) => await auth(service).getSessionInfo(query, {}, session?.user, { session });
  assert.equal((await info({}, { sessionId: 9, viaCookie: true, user: member })).sessionMarker, "cookie:9");
  assert.equal((await info({}, { sessionId: 9, user: member })).sessionMarker, undefined);
  assert.equal((await info({}, undefined)).sessionMarker, undefined);
});
