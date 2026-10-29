const assert = require("node:assert/strict");
const { parseArguments, assertMachineAccount, customTokenPayload, addTemporarySigner, removeTemporarySigner, wranglerEnvironment, parseSecretNames, getSignerPolicy, retryableSigningError } = require("./provision-schedule-sync.cjs");

assert.equal(parseArguments([]).mode, "check", "The default invocation must not provision credentials.");
assert.equal(parseArguments(["--check"]).mode, "check");
assert.equal(parseArguments(["--provision"]).mode, "provision");
assert.throws(() => parseArguments(["--check", "--provision"]));
assert.throws(() => parseArguments(["--service-account", "--provision"]));
assert.throws(() => parseArguments(["--unknown"]));

assert.equal(wranglerEnvironment(["secret", "list"], { WRANGLER_LOG: "error" }).WRANGLER_LOG, "log",
  "Secret-name JSON is written through Wrangler's log logger and must not be suppressed.");
assert.equal(wranglerEnvironment(["secret", "put", "FIREBASE_SCHEDULE_REFRESH_TOKEN"], { WRANGLER_LOG: "debug" }).WRANGLER_LOG, "error",
  "Credential writes must override inherited verbose logging.");
assert.equal(wranglerEnvironment(["secret", "put", "FIREBASE_SCHEDULE_REFRESH_TOKEN"], { WRANGLER_WRITE_LOGS: "true" }).WRANGLER_WRITE_LOGS, "false",
  "Wrangler must not persist request bodies to its debug log file during provisioning.");
assert.deepEqual([...parseSecretNames('[{"name":"VAPID_PRIVATE_KEY","type":"secret_text"},{"name":"API_FOOTBALL_KEY","type":"secret_text"}]')],
  ["VAPID_PRIVATE_KEY", "API_FOOTBALL_KEY"]);
assert.deepEqual([...parseSecretNames("[]")], []);
assert.throws(() => parseSecretNames(""), /JSON/);
assert.throws(() => parseSecretNames('{"name":"not-an-array"}'), /Nieprawidłowa/);
assert.throws(() => parseSecretNames('[{"type":"secret_text"}]'), /Nieprawidłowa/);

const policyRequests = [];
getSignerPolicy((...args) => { policyRequests.push(args); return {}; });
assert.equal(policyRequests.length, 1);
assert.equal(policyRequests[0][3], "POST", "IAM serviceAccounts.getIamPolicy uses POST, not GET.");
assert.equal(policyRequests[0][2], undefined, "The IAM getIamPolicy request body must be empty.");
assert.ok(policyRequests[0][0].endsWith(":getIamPolicy?options.requestedPolicyVersion=3"),
  "Reading version 3 must preserve existing conditional bindings.");
assert.equal(retryableSigningError({ status: 403, apiCode: "PERMISSION_DENIED", apiReasons: ["IAM_PERMISSION_DENIED"] }), true);
assert.equal(retryableSigningError({ status: 403, apiCode: "PERMISSION_DENIED", apiReasons: ["ACCESS_TOKEN_SCOPE_INSUFFICIENT"] }), false,
  "OAuth scope errors cannot be repaired by waiting for an IAM binding.");
assert.equal(retryableSigningError({ status: 401, apiCode: "UNAUTHENTICATED" }), false);
assert.equal(retryableSigningError({ status: 404, apiCode: "NOT_FOUND" }), false);

const machine = {
  localId: "trusted-schedule-sync-2026-27",
  displayName: "Trusted schedule sync 2026-27",
  customAttributes: JSON.stringify({ scheduleSync: true })
};
assert.doesNotThrow(() => assertMachineAccount(null));
assert.doesNotThrow(() => assertMachineAccount(machine));
assert.doesNotThrow(() => assertMachineAccount({ ...machine, customAttributes: "{}" }), "A marked machine account can recover a partially finished setup.");
for (const unexpected of [
  { email: "human@example.com" },
  { phoneNumber: "+48123456789" },
  { passwordHash: "hash" },
  { providerUserInfo: [{ providerId: "google.com" }] },
  { disabled: true },
  { localId: "another-user" },
  { customAttributes: JSON.stringify({ scheduleSync: true, admin: true }) },
  { displayName: "Existing unrelated account", customAttributes: "{}" }
]) assert.throws(() => assertMachineAccount({ ...machine, ...unexpected }), /Nie zmieniono konta/);

const payload = customTokenPayload("signer@test.iam.gserviceaccount.com", 1_000);
assert.deepEqual(payload.claims, { scheduleSync: true });
assert.equal(payload.uid, machine.localId);
assert.equal(payload.exp - payload.iat, 300);
assert.equal(payload.aud, "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit");
assert.equal(payload.sub, payload.iss);
assert.equal(Object.hasOwn(payload, "email"), false, "The machine token must not masquerade as a Google administrator.");

const member = "user:operator@example.com";
const policy = {
  etag: "original-etag",
  version: 3,
  bindings: [
    { role: "roles/viewer", members: ["user:viewer@example.com"] },
    { role: "roles/iam.serviceAccountTokenCreator", members: ["user:other@example.com"] },
    { role: "roles/iam.serviceAccountTokenCreator", members: [member], condition: { title: "Existing condition", expression: "true" } }
  ]
};
const before = structuredClone(policy);
const grant = addTemporarySigner(policy, member);
assert.equal(grant.added, true);
assert.equal(grant.policy.etag, "original-etag");
assert.deepEqual(policy, before, "IAM planning must not mutate the policy snapshot.");
assert.deepEqual(removeTemporarySigner(grant.policy, member), policy,
  "Cleanup must retain all other roles, members, conditions and etag.");
assert.equal(addTemporarySigner(grant.policy, member).added, false,
  "An existing signer permission must not be marked for later removal.");
assert.deepEqual(removeTemporarySigner({ version: 3, etag: "new", bindings: [
  { role: "roles/iam.serviceAccountTokenCreator", members: [member] },
  { role: "roles/viewer", members: ["user:new-concurrent-viewer@example.com"] }
] }, member), { version: 3, etag: "new", bindings: [
  { role: "roles/viewer", members: ["user:new-concurrent-viewer@example.com"] }
] }, "Cleanup must operate on the fresh policy and preserve concurrent unrelated access.");
console.log("OK: provisioning is opt-in, refuses unrelated/disabled identities, and mints only the dedicated short-lived custom identity.");
