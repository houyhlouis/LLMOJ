/* TwoFactorService on a disposable MariaDB database and a temporary redis-server; never a production database. */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const ts = require("typescript");

require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2019,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
      }
    }).outputText,
    filename
  );
// As in main.ts, which is not loaded here.
String.prototype.format ||= function (...args) {
  return require("node:util").format(String(this), ...args);
};
const Redis = require("ioredis");
const { DataSource } = require("typeorm");
const { UserEntity } = require("../../user/user.entity.ts");
const { UserAuthEntity } = require("../user-auth.entity.ts");
const { UserTwoFactorEntity } = require("./user-two-factor.entity.ts");
const { UserPasskeyEntity } = require("./user-passkey.entity.ts");
const { TwoFactorService } = require("./two-factor.service.ts");
const { LockService } = require("../../redis/lock.service.ts");
const totp = require("./totp.ts");
const { softwareAuthenticator } = require("./two-factor-test-helpers.cjs");

const configPath = process.env.LLMOJ_TWO_FACTOR_TEST_DB_CONFIG;
const redisAvailable = spawnSync("redis-server", ["--version"], { stdio: "ignore" }).status === 0;
const origin = "https://oj.example.com";
const b64u = buffer => Buffer.from(buffer).toString("base64url");

async function startRedis(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-two-factor-redis-"));
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  const child = spawn(
    "redis-server",
    ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", directory],
    { stdio: "ignore" }
  );
  t.after(() => {
    child.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (let attempt = 0; ; attempt++) {
    const listening = await new Promise(resolve => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (listening) break;
    if (attempt > 50) throw new Error("redis-server did not start");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const redis = new Redis({ port, host: "127.0.0.1" });
  t.after(() => redis.disconnect());
  return redis;
}

const registration = (authenticator, options, transports) => {
  const created = authenticator.create({ challenge: options.challenge });
  return {
    id: b64u(authenticator.credentialId),
    clientDataJSON: b64u(created.clientDataJSON),
    attestationObject: b64u(created.attestationObject),
    transports
  };
};
const assertion = (authenticator, options, overrides = {}) => {
  const signed = authenticator.get({ challenge: options.challenge, ...overrides });
  return {
    id: b64u(authenticator.credentialId),
    clientDataJSON: b64u(signed.clientDataJSON),
    authenticatorData: b64u(signed.authenticatorData),
    signature: b64u(signed.signature)
  };
};

test(
  "authenticator codes, recovery codes and passkeys as a second sign-in factor",
  {
    skip: (!configPath || !redisAvailable) && "needs LLMOJ_TWO_FACTOR_TEST_DB_CONFIG and redis-server",
    timeout: 120000
  },
  async t => {
    const database = JSON.parse(fs.readFileSync(configPath, "utf8")).services.database;
    assert.match(database.database, /^llmoj_test_two_factor$/, "Use only the dedicated disposable test database");
    const redis = await startRedis(t);
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-two-factor-state-"));
    t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
    const previousStateDirectory = process.env.HYHOJ_AI_STATE_DIR;
    process.env.HYHOJ_AI_STATE_DIR = stateDirectory;
    t.after(() => {
      if (previousStateDirectory === undefined) delete process.env.HYHOJ_AI_STATE_DIR;
      else process.env.HYHOJ_AI_STATE_DIR = previousStateDirectory;
    });

    const ds = new DataSource({
      ...database,
      entityPrefix: `tf_${crypto.randomBytes(4).toString("hex")}_`,
      entities: [UserEntity, UserAuthEntity, UserTwoFactorEntity, UserPasskeyEntity],
      synchronize: true,
      logging: false
    });
    await ds.initialize();
    t.after(async () => {
      const runner = ds.createQueryRunner();
      try {
        await runner.query("SET FOREIGN_KEY_CHECKS=0");
        for (const entity of [UserPasskeyEntity, UserTwoFactorEntity, UserAuthEntity, UserEntity])
          await runner.query(`DROP TABLE IF EXISTS \`${ds.getMetadata(entity).tableName}\``);
      } finally {
        await runner.query("SET FOREIGN_KEY_CHECKS=1");
        await runner.release();
        await ds.destroy();
      }
    });

    const redisService = { getClient: () => redis };
    const configService = { config: { preference: { siteName: "Test OJ" } } };
    const newService = () =>
      new TwoFactorService(
        ds,
        ds.getRepository(UserTwoFactorEntity),
        ds.getRepository(UserPasskeyEntity),
        redisService,
        new LockService(redisService),
        configService
      );
    const service = newService();
    const settings = ds.getRepository(UserTwoFactorEntity);
    const passkeys = ds.getRepository(UserPasskeyEntity);
    const createUser = async username =>
      await ds.getRepository(UserEntity).save({
        username,
        email: `${username}@example.invalid`,
        nickname: "",
        bio: "",
        avatarInfo: "gravatar:",
        isAdmin: false,
        acceptedProblemCount: 0,
        submissionCount: 0,
        rating: 0,
        publicEmail: false,
        registrationTime: new Date()
      });
    const user = await createUser("alice");
    const other = await createUser("bob");
    const codeAt = (secret, offset = 0) => totp.hotp(secret, totp.totpTimeStep(Date.now()) + offset);
    const clearFailures = async () => await redis.del(`two-factor:failures:${user.id}`);

    assert.deepEqual(await service.getStatus(user.id), {
      enabled: false,
      totp: false,
      totpEnabledAt: null,
      recoveryCodesRemaining: 0,
      passkeys: []
    });

    // Authenticator setup: confirmed with a working code, stored encrypted, recovery codes shown once.
    assert.deepEqual(await service.confirmTotpSetup(user, "000000"), { error: "SETUP_EXPIRED" });
    const setup = await service.beginTotpSetup(user);
    assert.match(setup.uri, /^otpauth:\/\/totp\/Test%20OJ:alice\?/);
    const secret = totp.base32Decode(setup.secret);
    const nearby = [-2, -1, 0, 1, 2].map(offset => codeAt(secret, offset));
    const wrong = ["000000", "111111", "222222", "333333", "444444", "555555"].find(code => !nearby.includes(code));
    assert.deepEqual(await service.confirmTotpSetup(user, wrong), { error: "INVALID_CODE" });
    const setupCode = codeAt(secret);
    const { recoveryCodes } = await service.confirmTotpSetup(user, setupCode);
    assert.equal(recoveryCodes.length, 10);
    assert.deepEqual(await service.beginTotpSetup(user), { error: "ALREADY_ENABLED" });
    const stored = await settings.findOneBy({ userId: user.id });
    assert.match(stored.totpSecret, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    assert(!stored.totpSecret.includes(setup.secret));
    assert.deepEqual(stored.recoveryCodes, recoveryCodes.map(totp.hashRecoveryCode));
    const key = fs.statSync(path.join(stateDirectory, "two-factor.key"));
    assert.equal(key.size, 32);
    assert.equal(key.mode & 0o777, 0o600);
    const status = await service.getStatus(user.id);
    assert.equal(status.enabled, true);
    assert.equal(status.totp, true);
    assert.equal(status.recoveryCodesRemaining, 10);
    assert.equal(await service.isEnabled(user.id), true);
    assert.equal(await service.isEnabled(other.id), false);

    // A sign-in challenge accepts an authenticator code once, and is itself single-use.
    let challenge = await service.createChallenge(user.id, origin);
    assert.deepEqual(challenge.methods, ["totp", "recoveryCode"]);
    assert.equal(challenge.passkey, undefined);
    assert.deepEqual(await service.verifyChallenge(challenge.token, origin, { totpCode: setupCode }), {
      error: "INVALID_CODE"
    });
    const loginCode = codeAt(secret, 1);
    assert.deepEqual(await service.verifyChallenge(challenge.token, origin, { totpCode: loginCode }), {
      userId: user.id
    });
    assert.deepEqual(await service.verifyChallenge(challenge.token, origin, { totpCode: codeAt(secret, -1) }), {
      error: "CHALLENGE_EXPIRED"
    });
    assert.deepEqual(await service.verifyChallenge("forged", origin, { totpCode: loginCode }), {
      error: "CHALLENGE_EXPIRED"
    });
    challenge = await service.createChallenge(user.id, origin);
    assert.deepEqual(await service.verifyChallenge(challenge.token, origin, { totpCode: loginCode }), {
      error: "INVALID_CODE"
    });

    // Five tries per challenge; ten failures per user in the window, even with new challenges.
    await clearFailures();
    challenge = await service.createChallenge(user.id, origin);
    for (let attempt = 0; attempt < 5; attempt++)
      assert.deepEqual(await service.verifyChallenge(challenge.token, origin, { totpCode: wrong }), {
        error: "INVALID_CODE"
      });
    assert.deepEqual(await service.verifyChallenge(challenge.token, origin, { totpCode: codeAt(secret) }), {
      error: "TOO_MANY_ATTEMPTS"
    });
    assert.deepEqual(await service.verifyChallenge(challenge.token, origin, { totpCode: codeAt(secret) }), {
      error: "CHALLENGE_EXPIRED"
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      challenge = await service.createChallenge(user.id, origin);
      await service.verifyChallenge(challenge.token, origin, { recoveryCode: "aaaa-aaaa-aaaa-aaaa" });
    }
    assert.equal(await service.failureLimitReached(user.id), true);
    challenge = await service.createChallenge(user.id, origin);
    assert.deepEqual(await service.verifyChallenge(challenge.token, origin, { recoveryCode: recoveryCodes[0] }), {
      error: "TOO_MANY_ATTEMPTS"
    });
    assert.equal((await service.getStatus(user.id)).recoveryCodesRemaining, 10, "a refused attempt uses no code");
    await clearFailures();

    // Recovery codes work once each, however they are typed.
    challenge = await service.createChallenge(user.id, origin);
    assert.deepEqual(
      await service.verifyChallenge(challenge.token, origin, {
        recoveryCode: recoveryCodes[0].toUpperCase().replace(/-/g, " ")
      }),
      { userId: user.id }
    );
    assert.equal((await service.getStatus(user.id)).recoveryCodesRemaining, 9);
    challenge = await service.createChallenge(user.id, origin);
    assert.deepEqual(await service.verifyChallenge(challenge.token, origin, { recoveryCode: recoveryCodes[0] }), {
      error: "INVALID_CODE"
    });
    // Two simultaneous answers to one challenge sign in once.
    challenge = await service.createChallenge(user.id, origin);
    const raced = await Promise.all(
      [recoveryCodes[1], recoveryCodes[2]].map(recoveryCode =>
        service.verifyChallenge(challenge.token, origin, { recoveryCode })
      )
    );
    assert.equal(raced.filter(result => result.userId === user.id).length, 1);
    assert.equal(raced.filter(result => result.error === "CHALLENGE_EXPIRED").length, 1);
    await clearFailures();

    // Passkeys need a secure origin and are bound to the site they were registered on.
    assert.deepEqual(await service.beginPasskeyRegistration(user, "http://oj.example.com"), {
      error: "PASSKEY_UNAVAILABLE"
    });
    const laptop = softwareAuthenticator("ES256");
    let begun = await service.beginPasskeyRegistration(user, origin);
    assert.equal(begun.options.rp.id, "oj.example.com");
    assert.equal(begun.options.rp.name, "Test OJ");
    assert.equal(begun.options.attestation, "none");
    assert.deepEqual(begun.options.excludeCredentials, []);
    assert.deepEqual(
      await service.finishPasskeyRegistration(
        user,
        "https://other.example.org",
        "Laptop",
        registration(laptop, begun.options)
      ),
      { error: "INVALID_PASSKEY" }
    );
    begun = await service.beginPasskeyRegistration(user, origin);
    const created = registration(laptop, begun.options, ["internal", "hybrid", "not a transport!"]);
    const finished = await service.finishPasskeyRegistration(user, origin, "Laptop", created);
    assert.equal(finished.error, undefined);
    assert.equal(finished.recoveryCodes, null, "existing recovery codes stay valid");
    assert.deepEqual(await service.finishPasskeyRegistration(user, origin, "Laptop", created), {
      error: "SETUP_EXPIRED"
    });
    begun = await service.beginPasskeyRegistration(user, origin);
    assert.deepEqual(begun.options.excludeCredentials, [
      { type: "public-key", id: b64u(laptop.credentialId), transports: ["internal", "hybrid"] }
    ]);
    assert.deepEqual(
      await service.finishPasskeyRegistration(other, origin, "Stolen", registration(laptop, begun.options)),
      { error: "SETUP_EXPIRED" }
    );
    assert.deepEqual(
      await service.finishPasskeyRegistration(user, origin, "Again", registration(laptop, begun.options)),
      {
        error: "INVALID_PASSKEY"
      }
    );
    const [saved] = (await service.getStatus(user.id)).passkeys;
    assert.equal(saved.name, "Laptop");
    assert.equal(saved.rpId, "oj.example.com");
    assert.equal(saved.lastUsedAt, null);

    challenge = await service.createChallenge(user.id, origin);
    assert.deepEqual(challenge.methods, ["totp", "passkey", "recoveryCode"]);
    assert.equal(challenge.passkey.rpId, "oj.example.com");
    assert.deepEqual(
      challenge.passkey.allowCredentials.map(credential => credential.id),
      [b64u(laptop.credentialId)]
    );
    assert.deepEqual(
      await service.verifyChallenge(challenge.token, "https://other.example.org", {
        passkey: assertion(laptop, challenge.passkey, { origin: "https://other.example.org" })
      }),
      { error: "INVALID_PASSKEY" }
    );
    assert.deepEqual(
      await service.verifyChallenge(challenge.token, origin, { passkey: assertion(laptop, challenge.passkey) }),
      { userId: user.id }
    );
    const used = await passkeys.findOneBy({ id: saved.id });
    assert.equal(used.signCount, 2);
    assert(used.lastUsedAt instanceof Date);
    challenge = await service.createChallenge(user.id, origin);
    assert.deepEqual(
      await service.verifyChallenge(challenge.token, origin, {
        passkey: assertion(laptop, challenge.passkey, { advance: 0 })
      }),
      { error: "INVALID_PASSKEY" },
      "a cloned authenticator that repeats its counter is refused"
    );
    const elsewhere = await service.createChallenge(user.id, "https://other.example.org");
    assert.deepEqual(elsewhere.methods, ["totp", "recoveryCode"]);
    await clearFailures();

    // Removing factors: recovery codes last as long as any factor does.
    assert.deepEqual(await service.disableTotp(user.id), {});
    assert.deepEqual(await service.disableTotp(user.id), { error: "NOT_ENABLED" });
    assert.equal((await service.getStatus(user.id)).enabled, true);
    assert.equal((await service.getStatus(user.id)).recoveryCodesRemaining, 7);
    assert.deepEqual(await service.removePasskey(other.id, saved.id), { error: "NO_SUCH_PASSKEY" });
    assert.deepEqual(await service.removePasskey(user.id, saved.id), {});
    assert.deepEqual(await service.getStatus(user.id), {
      enabled: false,
      totp: false,
      totpEnabledAt: null,
      recoveryCodesRemaining: 0,
      passkeys: []
    });
    assert.equal((await settings.findOneBy({ userId: user.id })).recoveryCodes, null);
    assert.deepEqual(await service.regenerateRecoveryCodes(user.id), { error: "NOT_ENABLED" });

    // A passkey alone enables two-factor sign-in, with new recovery codes.
    const phone = softwareAuthenticator("EdDSA");
    begun = await service.beginPasskeyRegistration(user, origin);
    const phoneCodes = (
      await service.finishPasskeyRegistration(user, origin, "Phone", registration(phone, begun.options))
    ).recoveryCodes;
    assert.equal(phoneCodes.length, 10);
    assert(!phoneCodes.some(code => recoveryCodes.includes(code)));
    const regenerated = (await service.regenerateRecoveryCodes(user.id)).recoveryCodes;
    assert.equal(regenerated.length, 10);
    challenge = await service.createChallenge(user.id, origin);
    assert.deepEqual(await service.verifyChallenge(challenge.token, origin, { recoveryCode: phoneCodes[0] }), {
      error: "INVALID_CODE"
    });
    assert.deepEqual(await service.verifyChallenge(challenge.token, origin, { recoveryCode: regenerated[0] }), {
      userId: user.id
    });

    // Replacing the authenticator right after using it: the new secret's first code still works.
    challenge = await service.createChallenge(other.id, origin);
    const otherSetup = await service.beginTotpSetup(other);
    const otherSecret = totp.base32Decode(otherSetup.secret);
    await service.confirmTotpSetup(other, codeAt(otherSecret));
    challenge = await service.createChallenge(other.id, origin);
    assert.deepEqual(await service.verifyChallenge(challenge.token, origin, { totpCode: codeAt(otherSecret, 1) }), {
      userId: other.id
    });
    assert.deepEqual(await service.disableTotp(other.id), {});
    const replaced = totp.base32Decode((await service.beginTotpSetup(other)).secret);
    assert.equal((await service.confirmTotpSetup(other, codeAt(replaced, 1))).recoveryCodes.length, 10);
    assert.deepEqual(await service.disableTotp(other.id), {});

    // An administrator reset removes every factor.
    await service.reset(user.id);
    assert.equal(await service.isEnabled(user.id), false);
    assert.equal(await passkeys.countBy({ userId: user.id }), 0);
    assert.equal(await settings.countBy({ userId: user.id }), 0);

    // A missing key never silently replaces the one protecting enrolled secrets.
    const again = await service.beginTotpSetup(other);
    await service.confirmTotpSetup(other, codeAt(totp.base32Decode(again.secret)));
    process.env.HYHOJ_AI_STATE_DIR = fs.mkdtempSync(path.join(stateDirectory, "lost-"));
    const restarted = newService();
    challenge = await restarted.createChallenge(other.id, origin);
    await assert.rejects(
      () =>
        restarted.verifyChallenge(challenge.token, origin, { totpCode: codeAt(totp.base32Decode(again.secret), 1) }),
      /Two-factor encryption key is missing/
    );
    assert.equal(fs.existsSync(path.join(process.env.HYHOJ_AI_STATE_DIR, "two-factor.key")), false);
  }
);
