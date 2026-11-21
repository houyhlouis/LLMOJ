/**
 * Code being written for a contest problem, kept in this browser so that a reload, a closed tab or a wrong click
 * doesn't lose it. There is one draft per account, contest, problem and language, and nothing is sent to the server.
 *
 * A browser keeps the drafts of one account at a time, which matters on shared computers: signing out deletes them,
 * signing in as someone else deletes the earlier account's, and a draft is deleted when it hasn't changed for
 * DRAFT_RETENTION_DAYS. Submitting keeps the draft, so the code is still there to fix after a wrong answer.
 */

const PREFIX = "llmoj.contestDraft.v1:";
export const DRAFT_RETENTION_DAYS = 14;
const RETENTION_MS = DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** The server accepts at most 1 MiB of code, so a longer draft couldn't be submitted and isn't kept. */
export const MAX_DRAFT_LENGTH = 1024 * 1024;
/** The most drafts one browser keeps; the ones changed longest ago go first. */
export const MAX_DRAFTS = 50;

export interface DraftOwner {
  userId: number;
  contestId: number;
  /** The contest's problem (its ID within the contest) */
  problemId: number;
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

const expired = (draft: ContestDraft, now: number) => now - draft.savedAt > RETENTION_MS;

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

export type DraftSaveResult = "saved" | "removed" | "not-kept";

/**
 * Keeps this code as the draft of this problem in this language; empty code removes the draft. "not-kept": the code is
 * too long for a submission, or the browser has no room or no storage for it.
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
  const count = storedKeys(store).length;
  if (count > MAX_DRAFTS) removeOldest(store, count - MAX_DRAFTS, key);
  return "saved";
}

export function removeDraft(owner: DraftOwner, language: string) {
  const store = storage();
  if (store && owner) remove(store, draftKey(owner, language));
}

/** Signing out: this browser forgets every contest draft. */
export function removeAllDrafts() {
  const store = storage();
  if (!store) return;
  for (const stored of storedKeys(store)) remove(store, stored.key);
}

/**
 * The server says who is signed in: drafts of any other account are deleted (a browser keeps one account's drafts),
 * and so are drafts that haven't changed for DRAFT_RETENTION_DAYS.
 */
export function keepOnlyDraftsOf(userId: number, now = Date.now()) {
  const store = storage();
  if (!store) return;
  for (const stored of storedKeys(store)) {
    const draft = stored.userId === userId ? read(store, stored.key) : null;
    if (!draft || expired(draft, now)) remove(store, stored.key);
  }
}
