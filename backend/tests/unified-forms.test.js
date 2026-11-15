import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import jwt from "jsonwebtoken";

// Form 6 in the same officials' inbox as the other forms (BLO field verification first, then the
// ERO/AERO decides), and every account being a voter's account: officials sign in on the voter
// portal, keep the voter's permissions, and a voter can be appointed to a role such as BLO.
// Synthetic data only. Needs its own disposable Redis (TEST_REDIS_URL).
process.env.STEP_UP_REQUIRED = process.env.STEP_UP_REQUIRED ?? "false"; // step-up is covered in phase7.test.js
process.env.ACCESS_TOKEN_SECRET = "test";
process.env.GEMINI_API = "";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
if (TEST_REDIS_URL) process.env.REDIS_URL = TEST_REDIS_URL;
const needsRedis = { skip: TEST_REDIS_URL ? false : "set TEST_REDIS_URL to a disposable Redis to run" };

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]).toString("base64")}`;
const runId = crypto.randomInt(0, 1e6);
let seq = 0;
const letters = (n) => String(n).replace(/\d/g, (d) => "ABCDEFGHIJ"[d]);

const DHARAMSHALA = { state: "Himachal Pradesh", district: "KANGRA", constituency: "DHARAMSHALA" };
const OTHER = { state: "Punjab", district: "Ludhiana", constituency: "Ludhiana South" };

let ctx;
const setup = async () => {
    if (ctx) return ctx;
    const { connectRedis, redis } = await import("../src/config/redis.js");
    const { saveUser, getUserByEpic } = await import("../src/repositories/user.repository.js");
    await connectRedis();
    const { default: app } = await import("../src/app.js");
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const ip = () => `10.${crypto.randomInt(0, 255)}.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 255)}`;
    const call = async (method, path, body, token) => {
        const res = await fetch(`${base}${path}`, {
            method, headers: { "Content-Type": "application/json", "X-Forwarded-For": ip(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const makeUser = async (role, jurisdiction = DHARAMSHALA) => {
        const user = { _id: crypto.randomUUID(), epic: `UNF${String(crypto.randomInt(0, 1e7)).padStart(7, "0")}`, role, name: `${role} ${runId}`, mustChangePassword: false, ...(jurisdiction ? { jurisdiction } : {}) };
        await saveUser(user);
        return { user, token: jwt.sign({ _id: user._id, epic: user.epic, role }, "test") };
    };
    ctx = {
        redis, call, server, getUserByEpic, makeUser,
        blo: await makeUser("blo"), ero: await makeUser("ero"), outsideBlo: await makeUser("blo", OTHER), eci: await makeUser("eci", null)
    };
    return ctx;
};
test.after(async () => { if (ctx) { ctx.server.close(); await ctx.redis().quit(); } });

const form6 = () => {
    seq += 1;
    return {
        applicant: { officialLanguage: { first: "अनु", surname: "वर्मा" }, english: { first: `anu u${letters(runId)}x${letters(seq)}`, surname: "verma" } },
        relative: { relation: "Father", officialLanguageName: "राजेश वर्मा", englishName: "RAJESH VERMA" },
        contact: { mobile: "9876500000", mobileOf: "Self", email: "", emailOf: "" },
        aadhaar: { option: "none", number: "" },
        gender: "Female",
        dateOfBirth: "2005-01-15",
        ageProof: { type: "birth-certificate", otherName: "" },
        address: { house: "7", street: "Main Bazaar", town: "Dharamshala", postOffice: "Dharamshala HO", pinCode: "176215", tehsil: "Dharamshala",
            district: "KANGRA", state: "Himachal Pradesh", assemblyConstituencyId: "S08-18" },
        addressProof: { type: "utility-bill", otherName: "", holder: "Self" },
        disability: { categories: [], otherDescription: "", percentage: "", certificateAttached: "" },
        familyMember: { name: "", relation: "", epic: "" },
        declaration: { placeOfBirth: { town: "Dharamshala", district: "KANGRA", state: "Himachal Pradesh" }, residentSince: { month: 1, year: "2005" },
            firstTimeApplicant: true, noListedAgeProof: false, confirmed: true, place: "Dharamshala" }
    };
};
const docs = () => ({ photo: { dataUrl: JPEG, fileName: "photo.jpg" }, ageProof: { dataUrl: PNG, fileName: "age.png" }, addressProof: { dataUrl: PNG, fileName: "bill.png" } });

test("Form 6 is in the shared forms inbox and follows the same flow: BLO first, then the ERO", needsRedis, async () => {
    const { call, blo, ero, outsideBlo, getUserByEpic } = await setup();
    const submitted = await call("POST", "/auth/register", { form6: form6(), documents: docs() });
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    const id = submitted.body.data.referenceId;

    // The catalogue lists Form 6 with the other forms.
    const catalogue = await call("GET", "/elector-forms");
    assert.ok(catalogue.body.data.forms.some((f) => f.code === "FORM_6" && f.route === "form-6"));

    // The BLO of the constituency sees it among the forms awaiting field verification.
    const inbox = await call("GET", "/elector-forms/staff?status=submitted&limit=500", undefined, blo.token);
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
    const item = inbox.body.data.items.find((a) => a._id === id);
    assert.ok(item, "Form 6 application is listed for the BLO");
    assert.equal(item.formCode, "FORM_6");
    assert.equal(item.status, "submitted");
    assert.equal(item.jurisdiction.constituency, "DHARAMSHALA");
    // ...and a BLO elsewhere does not.
    const elsewhere = await call("GET", "/elector-forms/staff?limit=500", undefined, outsideBlo.token);
    assert.ok(!elsewhere.body.data.items.some((a) => a._id === id));
    assert.equal((await call("GET", `/elector-forms/staff/${id}`, undefined, outsideBlo.token)).status, 403);

    // The detail view and documents open through the same endpoints as the other forms.
    const detail = await call("GET", `/elector-forms/staff/${id}`, undefined, blo.token);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.fields.relativeEnglishName, "RAJESH VERMA");
    assert.ok(!JSON.stringify(detail.body.data.fields).includes("aadhaar"));
    assert.deepEqual(detail.body.data.documents.map((d) => d.name).sort(), ["addressProof", "ageProof", "photo"]);
    const photo = await call("GET", `/elector-forms/staff/${id}/documents/photo`, undefined, blo.token);
    assert.equal(photo.status, 200);
    assert.equal(photo.body.data.dataUrl, JPEG);

    // The ERO cannot approve before the BLO's field verification.
    const early = await call("POST", `/elector-forms/staff/${id}/decide`, { decision: "approve" }, ero.token);
    assert.equal(early.status, 409, JSON.stringify(early.body));

    // The BLO cannot decide; they record field verification.
    assert.equal((await call("POST", `/elector-forms/staff/${id}/decide`, { decision: "approve" }, blo.token)).status, 403);
    const field = await call("POST", `/elector-forms/staff/${id}/field-report`, { recommendation: "approve", partNumber: "12", pollingStation: "Government School, Dharamshala" }, blo.token);
    assert.equal(field.status, 200, JSON.stringify(field.body));
    const verified = await call("GET", `/elector-forms/staff?status=field_verified&limit=500`, undefined, ero.token);
    assert.ok(verified.body.data.items.some((a) => a._id === id && a.fieldReport?.recommendation === "approve"));

    // The ERO decides: approval creates the roll entry and the voter account.
    const decided = await call("POST", `/elector-forms/staff/${id}/decide`, { decision: "approve", reason: "Verified" }, ero.token);
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    const epic = decided.body.data.epic;
    assert.match(epic, /^[A-Z]{3}\d{7}$/);
    assert.equal((await getUserByEpic(epic)).role, "voter");
    const after = await call("GET", `/elector-forms/staff/${id}`, undefined, ero.token);
    assert.equal(after.body.data.status, "approved");
    assert.equal(after.body.data.decision.epic, epic);
});

test("Form 6 rejection through the shared inbox needs a reason", needsRedis, async () => {
    const { call, ero } = await setup();
    const id = (await call("POST", "/auth/register", { form6: form6(), documents: docs() })).body.data.referenceId;
    assert.equal((await call("POST", `/elector-forms/staff/${id}/decide`, { decision: "reject", reason: "" }, ero.token)).status, 400);
    const rejected = await call("POST", `/elector-forms/staff/${id}/decide`, { decision: "reject", reason: "Not resident at the address given" }, ero.token);
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    const status = await call("GET", `/auth/register/${id}`);
    assert.equal(status.body.data.status, "rejected");
    assert.equal(status.body.data.note, "Not resident at the address given");
});

test("every account signs in on the voter portal; the other portals still admit only their role", needsRedis, async () => {
    const { call, ero, blo, makeUser } = await setup();
    const voter = await makeUser("voter", null);
    for (const who of [ero, blo, voter]) {
        const r = await call("POST", "/auth/login", { epic: who.user.epic, portal: "voter" });
        assert.equal(r.status, 200, `${who.user.role}: ${JSON.stringify(r.body)}`);
    }
    assert.equal((await call("POST", "/auth/login", { epic: ero.user.epic, portal: "ero" })).status, 200);
    assert.equal((await call("POST", "/auth/login", { epic: voter.user.epic, portal: "ero" })).status, 403);
    assert.equal((await call("POST", "/auth/login", { epic: voter.user.epic, portal: "blo" })).status, 403);
});

test("officials keep the voter's permissions", async () => {
    const { permissionsFor, VOTER_PERMISSIONS } = await import("../src/config/roles.js");
    for (const role of ["blo", "ero", "eci", "deo", "admin"]) {
        for (const p of VOTER_PERMISSIONS) assert.ok(permissionsFor(role).includes(p), `${role} has ${p}`);
    }
    assert.ok(permissionsFor("blo").includes("verification:field-report"));
    assert.ok(!permissionsFor("voter").includes("verification:field-report"));
    assert.deepEqual(permissionsFor("no-such-role"), []);
});

test("an official uses the voter's own endpoints", needsRedis, async () => {
    const { call, ero } = await setup();
    assert.equal((await call("GET", "/elector-forms/mine", undefined, ero.token)).status, 200);
    assert.equal((await call("GET", "/changes/my", undefined, ero.token)).status, 200);
});

test("a voter appointed as BLO becomes a BLO, keeps the voter's access, and returns to voter when revoked", needsRedis, async () => {
    const { call, eci, makeUser, getUserByEpic } = await setup();
    const voter = await makeUser("voter", null);
    // Before the appointment the voter has no BLO access.
    assert.equal((await call("GET", "/elector-forms/staff", undefined, voter.token)).status, 403);

    const granted = await call("POST", "/assignments", { epic: voter.user.epic, role: "blo", jurisdiction: DHARAMSHALA }, eci.token);
    assert.equal(granted.status, 201, JSON.stringify(granted.body));
    const promoted = await getUserByEpic(voter.user.epic);
    assert.equal(promoted.role, "blo");
    assert.equal(promoted.roleGrantedFrom, "voter");

    // The same session now opens both the BLO's inbox and the voter's own pages.
    assert.equal((await call("GET", "/elector-forms/staff", undefined, voter.token)).status, 200);
    assert.equal((await call("GET", "/elector-forms/mine", undefined, voter.token)).status, 200);
    // Both sign-in pages admit the account.
    assert.equal((await call("POST", "/auth/login", { epic: voter.user.epic, portal: "blo" })).status, 200);
    assert.equal((await call("POST", "/auth/login", { epic: voter.user.epic, portal: "voter" })).status, 200);

    // An account that already holds another official role is not silently changed.
    const ero = await makeUser("ero");
    assert.equal((await call("POST", "/assignments", { epic: ero.user.epic, role: "blo", jurisdiction: DHARAMSHALA }, eci.token)).status, 409);

    const revoked = await call("POST", `/assignments/${granted.body.data._id}/revoke`, { reason: "Appointment ended" }, eci.token);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const back = await getUserByEpic(voter.user.epic);
    assert.equal(back.role, "voter");
    assert.equal(back.roleGrantedFrom, undefined);
    assert.equal((await call("GET", "/elector-forms/staff", undefined, voter.token)).status, 403);
});
