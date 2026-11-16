import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

// Security hardening: request sanitising, pinned token algorithms, step-up tokens are not sessions,
// production warnings, and the extra response headers.
process.env.ACCESS_TOKEN_SECRET = "test-secret-for-security-tests";
process.env.STEP_UP_REQUIRED = process.env.STEP_UP_REQUIRED ?? "false";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
if (TEST_REDIS_URL) process.env.REDIS_URL = TEST_REDIS_URL;
const needsRedis = { skip: TEST_REDIS_URL ? false : "set TEST_REDIS_URL to a disposable Redis to run" };

const { stripDangerousKeys, sanitizeRequest } = await import("../src/middlewares/sanitize.middleware.js");
const { verifyAccessToken } = await import("../src/services/session.service.js");
const { signStepUp } = await import("../src/middlewares/stepUp.middleware.js");
const { configWarnings } = await import("../src/config/appMode.js");

test("sanitise: operator and prototype keys are removed at any depth; ordinary values are kept", () => {
    const body = JSON.parse('{"epic":{"$ne":null},"name":"Asha","__proto__":{"admin":true},"nested":[{"$where":"1","ok":1}],"constructor":{"prototype":{}}}');
    const stats = { removed: 0 };
    const clean = stripDangerousKeys(body, stats);
    assert.deepEqual(clean, { epic: {}, name: "Asha", nested: [{ ok: 1 }] });
    assert.equal(stats.removed, 4);
    assert.equal({}.admin, undefined);
    const buf = Buffer.from("x");
    assert.equal(stripDangerousKeys({ b: buf }).b, buf); // non-plain objects untouched
});

test("sanitise: the middleware cleans the body and pins a clean query on the request", () => {
    const req = { method: "POST", path: "/x", body: { a: 1, $gt: 2 }, query: { q: "1", $or: "x" } };
    let called = false;
    const warn = console.warn; console.warn = () => {};
    try { sanitizeRequest(req, {}, () => { called = true; }); } finally { console.warn = warn; }
    assert.ok(called);
    assert.deepEqual(req.body, { a: 1 });
    assert.deepEqual(req.query, { q: "1" });
});

test("tokens: only HS256 session tokens are accepted; 'none' and step-up tokens are refused", () => {
    const session = jwt.sign({ _id: "u1", epic: "ABC1234567", role: "voter" }, process.env.ACCESS_TOKEN_SECRET, { algorithm: "HS256", expiresIn: "1h" });
    assert.equal(verifyAccessToken(session)._id, "u1");
    const unsigned = jwt.sign({ _id: "u1" }, null, { algorithm: "none" });
    assert.throws(() => verifyAccessToken(unsigned));
    const hs512 = jwt.sign({ _id: "u1" }, process.env.ACCESS_TOKEN_SECRET, { algorithm: "HS512" });
    assert.throws(() => verifyAccessToken(hs512));
    assert.throws(() => verifyAccessToken(signStepUp({ _id: "u1" })), /not a session token/);
});

test("config: weak production settings are reported as warnings", () => {
    assert.deepEqual(configWarnings({ NODE_ENV: "development", ENABLE_DEMO_OTP_NOTIFICATIONS: "true" }), []);
    assert.deepEqual(configWarnings({ NODE_ENV: "production", APP_MODE: "training", ENABLE_DEMO_OTP_NOTIFICATIONS: "true" }), []);
    const w = configWarnings({ NODE_ENV: "production", ENABLE_DEMO_OTP_NOTIFICATIONS: "true" }).join(" ");
    assert.match(w, /ENABLE_DEMO_OTP_NOTIFICATIONS/);
    assert.match(w, /AADHAAR_ENCRYPTION_KEY/);
    assert.match(w, /PERSONA_WEBHOOK_SECRET/);
    assert.deepEqual(configWarnings({ NODE_ENV: "production", AADHAAR_ENCRYPTION_KEY: "k", PERSONA_WEBHOOK_SECRET: "s" }), []);
});

test("headers: browser-feature, opener and cross-domain policies on every API response", needsRedis, async () => {
    const { connectRedis } = await import("../src/config/redis.js");
    await connectRedis();
    const app = (await import("../src/app.js")).default;
    const server = app.listen(0);
    try {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/health`);
        assert.equal(r.headers.get("cross-origin-opener-policy"), "same-origin");
        assert.equal(r.headers.get("x-permitted-cross-domain-policies"), "none");
        assert.match(r.headers.get("permissions-policy"), /camera=\(\)/);
        // Plain HTTP outside production: no HSTS (browsers ignore it there anyway).
        assert.equal(r.headers.get("strict-transport-security"), null);
        const polluted = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/auth/login`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: '{"epic":{"$ne":null}}'
        });
        assert.equal(polluted.status, 400); // the operator is stripped, so the EPIC is simply missing/invalid
    } finally { server.close(); }
});
