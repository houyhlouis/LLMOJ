/**
 * Code being written for a contest problem, kept in this browser so that a reload, a closed tab or a wrong click
 * doesn't lose it. There is one draft per account, contest, problem and language, and nothing is sent to the server.
 *
 * A browser keeps the drafts of one account at a time, which matters on shared computers: signing out deletes them,
 * signing in as someone else deletes the earlier account's, and a draft is deleted when it hasn't changed for
 * DRAFT_RETENTION_DAYS. Submitting keeps the draft, so the code is still there to fix after a wrong answer.
 *
 * Signing out, and another account signing in, also start a new draft session in the browser. A page writes drafts
 * only in the session it was opened in, so whatever it still had to save when a new session started, in this tab or
 * another, is dropped: a deleted draft can't come back. A login session that merely expires (or ends on another
 * device) starts no new draft session, so the same account finds its drafts when it signs in again.
 */

const PREFIX = "llmoj.contestDraft.v1:";
/** The browser's draft session: `{ id, userId }`, the account it belongs to being null until one signs in */
const SESSION_KEY = "llmoj.contestDraftSession.v1";
/** The session of a browser that hasn't recorded one */
const FIRST_SESSION = "first";
export const DRAFT_RETENTION_DAYS = 14;
const RETENTION_MS = DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** The server accepts at most 1 MiB of code, so a longer draft couldn't be submitted and isn't kept. */
export const MAX_DRAFT_LENGTH = 1024 * 1024;
/** The most drafts one browser keeps; the ones changed longest ago go first. */
export const MAX_DRAFTS = 50;
/** How long typing pauses before the draft is saved; leaving the page saves it at once. */
export const DRAFT_SAVE_DELAY = 500;

export interface DraftOwner {
  userId: number;
  contestId: number;
  /** The contest's problem (its ID within the contest) */
  problemId: number;
  /** The draft session the page was opened in (currentDraftSession()): its drafts are written only while it lasts */
  session?: string;
}

export interface ContestDraft {
  code: string;
  options: Record<string, unknown>;
  savedAt: number;
}

interface StoredKey {
  key: string;
  userId: number;
  contestId: number;
  problemId: number;
  language: string;
}

interface DraftSession {
  id: string;
  userId: number | null;
}

/** The browser's storage, or null where it's blocked (e.g. some private windows) */
function storage(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

const draftKey = (owner: DraftOwner, language: string) =>
  `${PREFIX}${owner.userId}:${owner.contestId}:${owner.problemId}:${language}`;

function parseKey(key: string): StoredKey | null {
  if (typeof key !== "string" || !key.startsWith(PREFIX)) return null;
  const parts = key.slice(PREFIX.length).split(":");
  if (parts.length !== 4) return null;
  const [userId, contestId, problemId] = parts.slice(0, 3).map(Number);
  if (![userId, contestId, problemId].every(Number.isSafeInteger) || !parts[3]) return null;
  return { key, userId, contestId, problemId, language: parts[3] };
}

/** Every contest draft's key, read before any is removed (removing renumbers the storage's keys) */
function storedKeys(store: Storage): StoredKey[] {
  const keys: StoredKey[] = [];
  for (let i = 0; i < store.length; i++) {
    const parsed = parseKey(store.key(i));
    if (parsed) keys.push(parsed);
  }
  return keys;
}

function read(store: Storage, key: string): ContestDraft | null {
  try {
    const value = JSON.parse(store.getItem(key));
    if (!value || typeof value.code !== "string" || !Number.isFinite(value.savedAt)) return null;
    return {
      code: value.code,
      options: value.options && typeof value.options === "object" && !Array.isArray(value.options) ? value.options : {},
      savedAt: value.savedAt
    };
  } catch {
    return null;
  }
}

function remove(store: Storage, key: string) {
  try {
    store.removeItem(key);
  } catch {
    // Nothing more to do where storage refuses
  }
}

function removeEveryDraft(store: Storage) {
  for (const stored of storedKeys(store)) remove(store, stored.key);
}

const expired = (draft: ContestDraft, now: number) => now - draft.savedAt > RETENTION_MS;

// The draft session

/** The recorded session; an unreadable record counts as none */
function readSession(store: Storage): DraftSession {
  try {
    const value = JSON.parse(store.getItem(SESSION_KEY));
    if (
      value &&
      typeof value.id === "string" &&
      value.id &&
      (value.userId === null || Number.isSafeInteger(value.userId))
    )
      return { id: value.id, userId: value.userId };
  } catch {
    // As if there were none
  }
  return { id: FIRST_SESSION, userId: null };
}

function writeSession(store: Storage, session: DraftSession): boolean {
  try {
    store.setItem(SESSION_KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

/** Records a new session; a full storage gets room from the drafts, which a new session deletes anyway */
function startSession(store: Storage, session: DraftSession) {
  if (!writeSession(store, session)) {
    removeEveryDraft(store);
    writeSession(store, session);
  }
}

function newSessionId() {
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

// Set when this page signs out: it writes no draft again, even where the storage couldn't record the new session.
let signedOutHere = false;

/** Whether the owner's page may still write: it hasn't signed out, and its session is still the browser's */
function inSession(store: Storage, owner: DraftOwner) {
  return !signedOutHere && (owner.session ?? FIRST_SESSION) === readSession(store).id;
}

/** The browser's draft session now: a page keeps it in its DraftOwner when it opens */
export function currentDraftSession(): string {
  const store = storage();
  return store ? readSession(store).id : FIRST_SESSION;
}

/** Whether the page this owner belongs to may still write drafts */
export function draftSessionIsCurrent(owner: DraftOwner): boolean {
  const store = storage();
  return !!store && !!owner && inSession(store, owner);
}

const sessionListeners = new Set<() => void>();

function notifySessionChange() {
  for (const listener of [...sessionListeners]) listener();
}

// Another tab started a new session (its key changed) or cleared the storage (no key)
function onStorage(event: StorageEvent) {
  if (event.key === SESSION_KEY || event.key === null) notifySessionChange();
}

/** `listener` runs whenever a new draft session may have started, in this tab or another. Returns the unsubscribe. */
export function onDraftSessionChange(listener: () => void): () => void {
  if (!sessionListeners.size) window.addEventListener?.("storage", onStorage);
  sessionListeners.add(listener);
  return () => {
    if (sessionListeners.delete(listener) && !sessionListeners.size) window.removeEventListener?.("storage", onStorage);
  };
}

// Reading drafts

/** The draft of this problem in this language, if this browser has one that is still kept. */
export function loadDraft(owner: DraftOwner, language: string, now = Date.now()): ContestDraft | null {
  const store = storage();
  if (!store || !owner) return null;
  const key = draftKey(owner, language);
  const draft = read(store, key);
  if (draft && !expired(draft, now)) return draft;
  // An expired or unreadable draft goes
  if (store.getItem(key) != null) remove(store, key);
  return null;
}

/** Of these languages, the one whose draft of this problem changed last, or null without drafts. */
export function latestDraftLanguage(owner: DraftOwner, languages: string[], now = Date.now()): string | null {
  const store = storage();
  if (!store || !owner) return null;
  let latest: { language: string; savedAt: number } = null;
  for (const stored of storedKeys(store)) {
    if (
      stored.userId !== owner.userId ||
      stored.contestId !== owner.contestId ||
      stored.problemId !== owner.problemId ||
      !languages.includes(stored.language)
    )
      continue;
    const draft = loadDraft(owner, stored.language, now);
    if (draft && (!latest || draft.savedAt > latest.savedAt))
      latest = { language: stored.language, savedAt: draft.savedAt };
  }
  return latest?.language ?? null;
}

// Writing drafts

/** Removes the drafts changed longest ago, except `keep`; false when there was none to remove. */
function removeOldest(store: Storage, count: number, keep: string): boolean {
  const drafts = storedKeys(store)
    .filter(stored => stored.key !== keep)
    .map(stored => ({ key: stored.key, savedAt: read(store, stored.key)?.savedAt ?? -Infinity }))
    .sort((a, b) => a.savedAt - b.savedAt)
    .slice(0, count);
  for (const draft of drafts) remove(store, draft.key);
  return drafts.length > 0;
}

export type DraftSaveResult = "saved" | "removed" | "not-kept" | "ended";

/**
 * Keeps this code as the draft of this problem in this language; empty code removes the draft. "not-kept": the code is
 * too long for a submission, or the browser has no room or no storage for it. "ended": the page's draft session has
 * ended (signing out, or another account signing in), so nothing was written.
 */
export function saveDraft(
  owner: DraftOwner,
  language: string,
  code: string,
  options: Record<string, unknown>,
  now = Date.now()
): DraftSaveResult {
  const store = storage();
  if (!store || !owner) return "not-kept";
  if (!inSession(store, owner)) return "ended";
  const key = draftKey(owner, language);
  if (!code) {
    remove(store, key);
    return "removed";
  }
  if (code.length > MAX_DRAFT_LENGTH) {
    // An older, shorter draft would come back as if it were the latest code
    remove(store, key);
    return "not-kept";
  }
  const value = JSON.stringify({ code, options: options ?? {}, savedAt: now });
  // When the browser's storage is full, the drafts changed longest ago make room, one at a time
  for (;;) {
    try {
      store.setItem(key, value);
      break;
    } catch {
      if (!removeOldest(store, 1, key)) {
        remove(store, key);
        return "not-kept";
      }
    }
  }
  // Another tab may have started a new session while this was written: take the draft back
  if (!inSession(store, owner)) {
    remove(store, key);
    return "ended";
  }
  const count = storedKeys(store).length;
  if (count > MAX_DRAFTS) removeOldest(store, count - MAX_DRAFTS, key);
  return "saved";
}

/** Deletes this language's draft, unless the page's draft session has ended (whatever it had is gone already) */
export function removeDraft(owner: DraftOwner, language: string) {
  const store = storage();
  if (store && owner && inSession(store, owner)) remove(store, draftKey(owner, language));
}

/**
 * Signing out: every page of this browser stops writing drafts (this one at once, those in other tabs before their
 * next write), then the browser forgets every contest draft.
 */
export function signOutDrafts() {
  signedOutHere = true;
  const store = storage();
  if (store) {
    startSession(store, { id: newSessionId(), userId: null });
    removeEveryDraft(store);
  }
  notifySessionChange();
}

/**
 * The server says who is signed in: drafts of any other account are deleted (a browser keeps one account's drafts),
 * and so are drafts that haven't changed for DRAFT_RETENTION_DAYS. When the session belonged to another account, a
 * new one starts, so that account's pages (in any tab) stop writing; a session without an account takes this one.
 */
export function keepOnlyDraftsOf(userId: number, now = Date.now()) {
  const store = storage();
  if (!store) return;
  const session = readSession(store);
  if (session.userId !== userId) {
    if (session.userId === null) writeSession(store, { id: session.id, userId });
    else startSession(store, { id: newSessionId(), userId });
  }
  for (const stored of storedKeys(store)) {
    const draft = stored.userId === userId ? read(store, stored.key) : null;
    if (!draft || expired(draft, now)) remove(store, stored.key);
  }
  if (session.userId !== null && session.userId !== userId) notifySessionChange();
}

// The writer of a page's drafts

export interface DraftWriter {
  /** The code changed: it becomes the draft once typing pauses for DRAFT_SAVE_DELAY */
  keep(language: string, code: string, options: Record<string, unknown>): void;
  /** Saves this as the draft now (code moving to another language's draft) */
  save(language: string, code: string, options: Record<string, unknown>): void;
  /** Saves what's waiting now: before choosing another language, after submitting */
  flush(): void;
  /** Deleting the draft: drops what's waiting and deletes this language's draft */
  discard(language: string): void;
  /** The page goes: saves what's waiting and stops listening */
  close(): void;
}

/**
 * The one way a page writes its drafts: after a pause in typing, at once when the tab is hidden or the page left, and
 * when the page closes. Each write belongs to the page's draft session (saveDraft): once signing out or another
 * account starts a new one, here or in another tab, what was waiting is dropped and `onResult("ended")` says so.
 * A null owner (a visitor, an answer-file problem) keeps no drafts.
 */
export function createDraftWriter(owner: DraftOwner | null, onResult: (result: DraftSaveResult) => void): DraftWriter {
  let waiting: { language: string; code: string; options: Record<string, unknown> } = null;
  let timer: ReturnType<typeof setTimeout> = null;
  let ended = false,
    closed = false;
  function stopTimer() {
    if (timer != null) clearTimeout(timer);
    timer = null;
  }
  function end() {
    if (ended) return;
    ended = true;
    waiting = null;
    stopTimer();
    onResult("ended");
  }
  function flush() {
    stopTimer();
    const next = waiting;
    waiting = null;
    if (!next || ended) return;
    const result = saveDraft(owner, next.language, next.code, next.options);
    if (result === "ended") end();
    else onResult(result);
  }
  function wait(language: string, code: string, options: Record<string, unknown>) {
    if (!owner || ended || closed) return false;
    waiting = { language, code, options };
    stopTimer();
    return true;
  }
  const onPageHide = () => flush();
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") flush();
  };
  let stopWatching = () => {};
  if (owner) {
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    stopWatching = onDraftSessionChange(() => {
      if (!draftSessionIsCurrent(owner)) end();
    });
  }
  return {
    keep(language, code, options) {
      if (wait(language, code, options)) timer = setTimeout(flush, DRAFT_SAVE_DELAY);
    },
    save(language, code, options) {
      if (wait(language, code, options)) flush();
    },
    flush,
    discard(language) {
      stopTimer();
      waiting = null;
      removeDraft(owner, language);
    },
    close() {
      if (closed) return;
      flush();
      closed = true;
      if (!owner) return;
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopWatching();
    }
  };
}
