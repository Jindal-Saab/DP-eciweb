# Security — ECIWEB

This document lists the security and privacy features of the ECIWEB election-management prototype (React frontend on Vercel, Express API, Redis as the system of record, MongoDB as optional read models). It also lists what is still open.

Every feature below is implemented in this repository. Features marked **(new)** were added in the November 2026 security review. Backend tests: `cd backend && TEST_REDIS_URL=redis://127.0.0.1:6379 npm test` (158 tests, including `tests/security.test.js`).

---

## ⚠️ Action needed before real users

| # | Issue | Risk | What to do |
|---|---|---|---|
| 1 | **`ENABLE_DEMO_OTP_NOTIFICATIONS=true` in production** | **Critical.** `GET /api/v1/notifications?epic=…` returns the current sign-in code for any EPIC. Anyone who knows or guesses an EPIC number, including an official's or the ECI administrator's, can sign in as that person. | Connect a real SMS gateway, then set the variable to `false` in Vercel. Until then, treat the live site as a demo and keep real personal data off it. The server now prints a `SECURITY WARNING` at start-up while this is on. |
| 2 | `AADHAAR_ENCRYPTION_KEY` not set in production | Low. Only the last 4 Aadhaar digits are kept, which is safe, but the full number cannot be stored encrypted if it is ever needed. | Set a 32-byte hex key in Vercel if full numbers are required; otherwise keep it unset (data minimisation). |
| 3 | `PERSONA_WEBHOOK_SECRET` not set in production | Persona webhooks are refused (503), so verification results never arrive. | Add the webhook secret from the Persona dashboard. |
| 4 | `frontend/.env` holds a Persona API key | The key is not bundled (it has no `VITE_` prefix) and is git-ignored, but a server secret should not sit in the frontend folder. | Delete `frontend/.env`; keep Persona keys only in the backend environment. |
| 5 | Full Content-Security-Policy is report-only | Script, style and connection rules are logged but not enforced yet. | Open the live site, check the browser console for CSP report-only messages, adjust the allowed sources, then rename the header to `Content-Security-Policy` in `frontend/vercel.json`. |
| 6 | Public repository | Anyone can read the code. No `.env` file has ever been committed (checked), but any future slip would be public. | Turn on GitHub secret scanning, push protection and Dependabot alerts. |
| 7 | The site is titled "Election Commission of India" on a public domain | Visitors may believe it is the official ECI portal and upload real identity documents. | Show a visible "prototype / not the official ECI website" notice on every page, and link to voters.eci.gov.in for real services. |

---

## 1. Encryption

### In transit
- **HTTPS everywhere.** Vercel serves only HTTPS with TLS 1.2/1.3 and redirects HTTP.
- **HSTS (new):** `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` is sent on the frontend (`frontend/vercel.json`) and on the API in production (`backend/src/app.js`).
- `upgrade-insecure-requests` in the CSP **(new)** upgrades any stray `http://` sub-request.
- **Database connections are encrypted:** MongoDB uses `mongodb+srv://` (TLS), and any non-local `redis://` URL is upgraded to `rediss://` (TLS) automatically (`config/redis.js`).

### At rest
- **Aadhaar numbers:** AES-256-GCM, with the application ID bound as additional data so a ciphertext cannot be moved to another record (`utils/form6.js`). They are stored only when `AADHAAR_ENCRYPTION_KEY` is set; otherwise only the last 4 digits are kept. The encrypted value is removed before any record is sent to a client (`withoutSecrets`). Aadhaar duplicate checks use an HMAC, not the number.
- **One-time codes:** stored only as SHA-256 digests in Redis, never in plain text (`services/otp.service.js`).
- **Polling-station offline packages:** encrypted with AES-256-GCM under a per-device key (HKDF-SHA256), signed with Ed25519, and integrity-checked with SHA-256. The browser verifies the signature and hash before saving (`services/stationPackage.service.js`, `frontend/src/offline/crypto.js`).
- **Device secrets:** stored hashed and compared in constant time (`services/device.service.js`).
- **Managed encryption:** the hosted Redis and MongoDB providers encrypt their disks.

### End-to-end
True end-to-end encryption, where the server cannot read the data, fits user-to-user messaging, and this app has none. The closest equivalent is the station package: the server seals it for one registered device, and nobody else can open or alter it. The server can still derive the key. See §11 for a future option.

## 2. Authentication
- **No passwords.** Every account (voter, BLO, officer) signs in with an EPIC or BLO ID plus a **6-digit one-time code**. Codes are generated with `crypto.randomInt`, expire after 5 minutes (2 minutes for BLOs), allow 5 attempts, are used up when correct, and are compared in constant time.
- **Step-up re-authentication** for sensitive approvals: a fresh code gives a 10-minute token bound to the account and sent in `X-Step-Up`. Production refuses to start with step-up turned off.
- **Identity verification** through Persona (document + face). The browser cannot report its own result; only signed webhooks count.
- **Account suspension** ends the session and assignments immediately, and no session is issued to a suspended account.
- **Demo codes are never written to server logs in production (new).**

## 3. Sessions and tokens
- **httpOnly, Secure cookie** (`accessToken`); the session lasts 8 hours.
- **Tokens no longer stored in `localStorage` (new).** The frontend relies only on the httpOnly cookie, so an injected script cannot steal a session. Old stored tokens are deleted on load.
- **Pinned JWT algorithm (new):** only HS256 tokens are accepted. `alg: none` and other algorithms are refused (`verifyAccessToken`).
- **Step-up tokens cannot be used as sessions (new).**
- **Server-side sign-out:** each token has an ID (`jti`) that is revoked in Redis on logout. "Sign out everywhere" ends all of an account's sessions.
- **Revocation enforced everywhere (new):** the live-updates socket, the public roll search and optional-login routes now also refuse revoked and post-password-change tokens.
- The production start-up check refuses an `ACCESS_TOKEN_SECRET` shorter than 32 characters.

## 4. Authorization
- **Role-based permissions** for every role (`config/roles.js`, `config/permissions.js`), checked on the server with `authorize(...)`. Hiding a button in the UI is never the only control.
- **Jurisdiction scoping:** officers act only on records inside their assignment (state, district, constituency, part or station). Assignments have validity windows and can be revoked, and revoking is audited.
- **Ownership checks:** a voter can read only their own applications and records, and officers outside a constituency cannot see its applications (covered by tests).
- **Separation of duties:** a BLO verifies, and only the ERO/AERO of the constituency decides.
- **Live updates** go only to sockets whose assignments cover the event's jurisdiction. Assignments are re-checked every minute.

## 5. Protection against common attacks

| Attack | Protection |
|---|---|
| **CSRF** | A cookie-only session must send `X-Requested-With: XMLHttpRequest` on every state-changing request. Browsers send it cross-site only after a CORS preflight, which the origin allow-list refuses. |
| **CORS abuse** | Strict allow-list (`CLIENT_URL`, the site's domains, this deployment's Vercel URLs); disallowed preflights get 403. |
| **NoSQL operator injection (new)** | `sanitize.middleware.js` strips every key starting with `$` from bodies and query strings, so `{"epic":{"$ne":null}}` cannot match all records. Search text is regex-escaped. |
| **Prototype pollution (new)** | The same middleware strips `__proto__`, `constructor` and `prototype` keys at any depth. |
| **XSS** | React escapes all output, and the API serves only JSON with `Content-Security-Policy: default-src 'none'`. |
| **Clickjacking** | `X-Frame-Options: DENY` and `frame-ancestors 'none'` on the site and the API **(new on the site)**. |
| **MIME sniffing** | `X-Content-Type-Options: nosniff` everywhere. |
| **Brute force and enumeration** | Redis-backed rate limits shared across all instances: sign-in 20 per 15 min, registration 10 per hour, public lookups 60 per minute, **registration status 60 per 15 min (new)**, **OTP notification feed 60 per minute (new)**. |
| **Duplicate or replayed submissions** | `Idempotency-Key` support, duplicate fingerprints for pending applications, and per-record locks for approvals. |
| **Webhook forgery** | Persona webhooks are checked with HMAC-SHA256 over the raw body plus timestamp, in constant time. |
| **Oversized requests** | Per-route body limits (8–30 MB for document uploads, 1 MB for form posts). |
| **Information leakage** | `X-Powered-By` is removed, 500 errors return a generic message, and `Cache-Control: no-store` is set on API responses. |

## 6. Security headers

**API (`backend/src/app.js`):** `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. New: `Strict-Transport-Security`, `Cross-Origin-Opener-Policy`, `Permissions-Policy`, `X-Permitted-Cross-Domain-Policies`, `X-DNS-Prefetch-Control`.

**Website (`frontend/vercel.json`, new):** `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (microphone, payment, USB, serial and Bluetooth off; camera and location left on for document capture and the nearest-booth search), `Cross-Origin-Opener-Policy: same-origin-allow-popups`, an enforced CSP (`frame-ancestors`, `object-src`, `base-uri`, `form-action`, `upgrade-insecure-requests`) and a full report-only CSP.

## 7. File uploads
- The real file type is checked from its **magic bytes**, not the extension or the browser's claim (`utils/documentProof.js`). Only JPEG, PNG and WebP images are accepted.
- Size limits per document (2–6 MB) and per request.
- File names are cleaned of path and control characters.
- Multer temporary files are deleted in a `finally` block.
- **Application documents are visible only to the assigned officials and are deleted after the decision.**

## 8. Privacy and data protection (DPDP Act 2023)
- **Data minimisation:** only the last 4 Aadhaar digits by default; offline packages exclude dates of birth; external source records keep only the minimum fields.
- **Masking:** the public roll search hides addresses (only the voter sees their own), application status views are masked, observer bank details and BLO mobiles are masked (`******3210`), and the voter-slip QR holds only an opaque reference.
- **Whether someone voted is never public.**
- **Retention:** application documents are deleted after the decision; OTPs, step-up tokens, idempotency keys and revocation entries expire automatically.
- **Drafts in the browser** never include Aadhaar or PIN fields.
- **Service worker** caches only the app shell, never API responses.
- **Training mode** (`APP_MODE=training`) labels every response and screen, and blocks connecting real government data sources or official result feeds.

## 9. Audit and monitoring
- An **append-only, tamper-evident audit trail**: every event carries a hash chained to the previous one, anchored checkpoints are kept in MongoDB, and a rewritten entry is detected even if its hash was recomputed.
- Every registration step, assignment, approval, sign-out-everywhere and data-store sync is audited, and the audit is visible only within the caller's jurisdiction.
- Operational event history, device heartbeats and offline detection, control-room alerts, and a `/api/v1/health` endpoint.
- Blocked CORS origins and stripped request keys **(new)** are logged.

## 10. Configuration safety
- Production **refuses to start** with a short token secret, Persona demo mode on in live mode, step-up turned off, no `PACKAGE_SIGNING_KEY`, or no `CLIENT_URL`.
- **Start-up security warnings (new):** demo OTP feed on, no Aadhaar key, no Persona webhook secret.
- All secrets live in environment variables; `.env*` files are git-ignored and none has been committed.
- Persona credentials stay on the backend.

## 11. Recommended next steps
1. Fix items 1–7 in the table at the top.
2. Add an SMS/OTP provider with per-number send limits.
3. Add 2FA with a passkey or authenticator app for ECI, CEO, DEO and RO accounts.
4. Run `npm audit` and turn on Dependabot. The audit could not run during this review because the network was blocked.
5. Get an external penetration test before using real voter data, and write a CERT-In 6-hour incident-reporting runbook.
6. Optional true end-to-end encryption: encrypt observer reports and other confidential notes in the browser with the recipient's public key (Web Crypto, ECDH + AES-GCM) so the server stores only ciphertext.
