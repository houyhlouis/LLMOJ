/** Shared guard for synthetic loopback tests; never modify a user's real provider settings. */
import assert from "node:assert/strict";
import { request, readState, db, close } from "../../test/integration-client.mjs";
export const state = readState();
export const fixtureUser = process.env.HYHOJ_AI_FIXTURE_USER || "ai_fixture";
assert.notEqual(fixtureUser, "admin", "Use a dedicated fixture account, never admin");
export const fixtureUserId = state.users[fixtureUser];
export const token = state.tokens[fixtureUser];
let prepared = false;
export async function prepareMockFixture() {
  try {
    assert(
      Number.isInteger(fixtureUserId) && token,
      "Create a dedicated fixture account in the isolated test database and provide HYHOJ_TEST_STATE"
    );
    const active = await db.query("SELECT COUNT(*) n FROM ai_job WHERE status IN ('queued','running')");
    assert.equal(Number(active[0].n), 0, "Wait for all existing QA AI jobs to finish before synthetic mock tests");
    const saved = await db.query("SELECT COUNT(*) n FROM ai_configuration WHERE userId=?", [fixtureUserId]);
    if (Number(saved[0].n)) {
      const current = await request(token, "ai/getConfiguration", {});
      assert(!current.error, "Cannot inspect fixture configuration safely");
      for (const part of [current.llm, current.search]) {
        if (!part?.hasKey) continue;
        const url = new URL(part.baseUrl);
        assert.equal(url.hostname, "127.0.0.1", "Refusing to replace a non-loopback provider configuration");
        assert.equal(url.port, "2230", "Refusing to replace a provider outside the fixed mock port");
      }
    }
    prepared = true;
  } catch (error) {
    await close();
    throw error;
  }
}
export async function clearMockFixtureConfiguration() {
  if (!prepared) return;
  // This owner alone was checked before any write. Other users' configurations are untouched.
  await db.query("DELETE FROM ai_configuration WHERE userId=?", [fixtureUserId]);
}
