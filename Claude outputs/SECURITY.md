# Security & Privacy Plan — eciweb-mannat

This document lists all the security and privacy measures for the website and its users. Each item has a checkbox so you can track progress. Code examples assume a typical Node.js/Express + database stack. The same ideas apply to other stacks.

---

## 0. A note on "End-to-End Encryption"

**End-to-end encryption (E2EE)** means *only the sender and the recipient* can read the data, and the server cannot. It only makes sense for **user-to-user content** such as private chat messages or shared private files. A normal website (login, profiles, forms) is protected by the **three layers of encryption** below, and those layers are what "secure end to end" means for most sites:

| Layer | What it protects | How |
|---|---|---|
| **In transit** | Data moving between the browser and the server | HTTPS / TLS 1.2+ (ideally 1.3), HSTS |
| **At rest** | Data stored in the database, backups and file storage | AES-256 disk/DB encryption + field-level encryption for sensitive fields |
| **End-to-end** (optional) | User-to-user messages and files | Client-side encryption (Web Crypto API / libsodium / Signal protocol); the server stores only ciphertext |

**Caveat for true E2EE:** if users lose their private key, their data cannot be recovered. You will need a key-backup or recovery design. You also cannot run server-side search or moderation on that content.

---

## 1. Encryption in Transit (HTTPS)

- [ ] Serve the whole site over **HTTPS only**, using a free certificate from Let's Encrypt or one from your host or CDN.
- [ ] Redirect all HTTP traffic to HTTPS (301).
- [ ] Turn on **TLS 1.2 and 1.3 only**; turn off SSL, TLS 1.0 and TLS 1.1.
- [ ] Turn on **HSTS**: `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
- [ ] Submit the domain to the HSTS preload list (hstspreload.org).
- [ ] Encrypt **internal** connections too: app ↔ database (`sslmode=require`) and app ↔ cache/queue.
- [ ] Set up automatic certificate renewal and an expiry alert.
- [ ] Test your configuration with SSL Labs (target grade **A+**).

## 2. Encryption at Rest

- [ ] Turn on **database encryption at rest** (most managed databases offer AES-256).
- [ ] Turn on encryption for **file storage** (for example, S3 server-side encryption) and for **backups**.
- [ ] Add **field-level encryption** for highly sensitive data such as phone numbers, ID numbers, addresses and documents:
  ```js
  // AES-256-GCM field encryption (Node.js)
  import crypto from 'crypto';
  const KEY = Buffer.from(process.env.DATA_KEY, 'base64'); // 32 bytes, from a secrets manager

  export function encrypt(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
  }
  export function decrypt(payload) {
    const buf = Buffer.from(payload, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  }
  ```
- [ ] Keep encryption keys in a **secrets manager or KMS** (AWS KMS, GCP KMS, Vault, Doppler). Never put them in code or the database.
- [ ] Rotate keys on a schedule (for example, yearly) and right away if a leak is suspected.

## 3. Optional: True End-to-End Encryption (for user-to-user messages or files)

- [ ] Generate a key pair **in the browser** for each user (Web Crypto API, `libsodium.js` or TweetNaCl).
- [ ] Upload **only the public key** to the server. Store the private key encrypted with a key derived from the user's passphrase (Argon2id or PBKDF2).
- [ ] Encrypt each message on the client with the recipient's public key. The server stores and relays only ciphertext.
- [ ] For chat, use an established protocol (the Signal protocol via `libsignal`) rather than inventing your own.
- [ ] Show users a key fingerprint or "safety number" so they can verify each other.
- [ ] Design key backup and recovery before launch.

## 4. Authentication

- [ ] Hash passwords with **Argon2id** (preferred) or **bcrypt** (cost ≥ 12). Never store plaintext passwords, and never use MD5 or SHA-1 for passwords.
  ```js
  import argon2 from 'argon2';
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const ok = await argon2.verify(hash, password);
  ```
- [ ] Require passwords of at least **8–12 characters** and check them against breached-password lists (Have I Been Pwned "k-anonymity" API). Don't force odd composition rules.
- [ ] Offer **two-factor authentication (2FA)**: TOTP authenticator apps, and passkeys/WebAuthn if possible. Make 2FA mandatory for admins.
- [ ] Add **rate limiting and lockout** on login, signup, OTP and password-reset endpoints.
- [ ] Use generic error messages ("Invalid email or password") so attackers can't find out which accounts exist.
- [ ] Make password-reset tokens **single-use, random (≥ 32 bytes), hashed in the DB and expiring in 15–60 minutes**.
- [ ] Verify the email address (or phone with OTP) at signup.
- [ ] Show a CAPTCHA (hCaptcha, Cloudflare Turnstile or reCAPTCHA) after repeated failures or on signup.
- [ ] Notify users by email about new logins, password changes and 2FA changes.

## 5. Session Management

- [ ] Store sessions or tokens in **cookies** with `HttpOnly; Secure; SameSite=Lax` (or `Strict`). Don't keep tokens in `localStorage`.
  ```js
  res.cookie('sid', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 1000*60*60*24 });
  ```
- [ ] **Regenerate the session ID** after login and after a privilege change.
- [ ] Use an idle timeout (for example, 30 minutes for admins) and an absolute session lifetime.
- [ ] On logout, delete the session **on the server**, not just the cookie.
- [ ] Add a "Log out of all devices" option and invalidate all sessions on password change.
- [ ] If you use JWTs, use short-lived access tokens (≤ 15 minutes) plus rotating refresh tokens, a strong secret or RS256/EdDSA, and always verify `alg`, `exp`, `iss` and `aud`.

## 6. Authorization (Access Control)

- [ ] **Deny by default.** Every API route checks that the user is logged in *and* allowed to do this action.
- [ ] Check **ownership** on every resource to prevent IDOR (one user changing an ID to see someone else's data):
  ```js
  const doc = await Doc.findOne({ _id: req.params.id, ownerId: req.user.id });
  if (!doc) return res.sendStatus(404);
  ```
- [ ] Use role-based access control (user, moderator, admin) enforced **on the server**. Never rely on hiding buttons in the UI.
- [ ] Put the admin panel behind a separate route with 2FA and an IP allowlist if possible.
- [ ] Use random IDs (UUIDs) for public-facing resources instead of sequential numbers.

## 7. Input Validation & Injection Prevention

- [ ] Validate **all input on the server** (type, length, format) with a schema library (Zod, Joi, express-validator).
- [ ] **SQL injection:** use parameterized queries or an ORM only. Never concatenate strings into SQL.
  ```js
  db.query('SELECT * FROM users WHERE email = $1', [email]); // ✅
  ```
- [ ] **NoSQL injection:** reject objects where strings are expected (`express-mongo-sanitize`).
- [ ] **XSS:** escape all output (React and most template engines escape by default). Sanitize any user HTML with **DOMPurify**. Avoid `innerHTML` and `dangerouslySetInnerHTML`.
- [ ] **Command injection:** never pass user input to `exec` or shell commands.
- [ ] **Path traversal:** never build file paths from user input.
- [ ] **SSRF:** if the server fetches user-supplied URLs, allowlist domains and block internal IPs (169.254.x.x, 10.x, 127.x and similar).

## 8. CSRF Protection

- [ ] Use `SameSite=Lax`/`Strict` cookies **plus** CSRF tokens (or double-submit cookies) on all state-changing requests (POST, PUT, PATCH, DELETE).
- [ ] Never change state with GET requests.

## 9. Security Headers

Set these on every response (Express: `helmet`):

```js
import helmet from 'helmet';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],            // add trusted CDNs only if needed
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));
app.disable('x-powered-by');
```

- [ ] `Content-Security-Policy` (blocks most XSS)
- [ ] `Strict-Transport-Security`
- [ ] `X-Content-Type-Options: nosniff`
- [ ] `X-Frame-Options: DENY` / `frame-ancestors 'none'` (clickjacking)
- [ ] `Referrer-Policy: strict-origin-when-cross-origin`
- [ ] `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- [ ] Remove the `X-Powered-By` and `Server` version headers.
- [ ] Check the result with securityheaders.com (target grade **A**).

## 10. CORS

- [ ] Allow only your own domain(s). Never use `*` together with credentials.
  ```js
  app.use(cors({ origin: ['https://yourdomain.com'], credentials: true }));
  ```

## 11. API Security & Rate Limiting

- [ ] Set **global and per-route rate limits** (`express-rate-limit`, or rate limits at your CDN/WAF).
- [ ] Set request body size limits (for example, `express.json({ limit: '100kb' })`).
- [ ] Return only the fields the client needs. Never send password hashes, tokens or internal fields.
- [ ] Use generic error messages in production with no stack traces (`NODE_ENV=production`).
- [ ] Keep API keys for third-party services on the server only, never in frontend code.

## 12. File Uploads

- [ ] Allowlist file types and check the **actual content (magic bytes)**, not just the extension.
- [ ] Set a size limit for each file.
- [ ] Rename files to random names, and store them **outside the web root** or in object storage (S3 or similar).
- [ ] Serve user files from a **separate domain** with `Content-Disposition: attachment` where appropriate.
- [ ] Scan uploads for malware (ClamAV or a cloud scanning service).
- [ ] Strip EXIF metadata (GPS location) from user images to protect privacy.

## 13. Secrets & Configuration

- [ ] Keep all secrets in environment variables or a secrets manager. **Never commit `.env`** (add it to `.gitignore`).
- [ ] Scan the repo history for leaked secrets (`gitleaks`, GitHub secret scanning). If any are found, rotate them.
- [ ] Use separate credentials for development, staging and production.
- [ ] Give the database user **least privilege** (no DROP or superuser for the app).

## 14. Dependencies & Supply Chain

- [ ] Run `npm audit` / `pip-audit` regularly, and turn on **Dependabot** or **Renovate**.
- [ ] Commit lockfiles (`package-lock.json`) and use `npm ci` in CI.
- [ ] Use **Subresource Integrity (SRI)** for any CDN scripts:
  `<script src="https://cdn…/lib.js" integrity="sha384-…" crossorigin="anonymous"></script>`
- [ ] Remove unused packages, and check new packages before adding them.

## 15. Infrastructure & Server Hardening

- [ ] Put the site behind a **CDN/WAF** (Cloudflare or AWS WAF) for DDoS protection and bot filtering.
- [ ] Use a firewall and expose only ports 80 and 443. The database should **never** be publicly reachable.
- [ ] SSH: key-based login only, no root login, and fail2ban.
- [ ] Turn on automatic OS security updates.
- [ ] Run the app as a non-root user. In containers, use minimal images and scan them (Trivy).
- [ ] Use separate environments; staging must not use real user data.

## 16. Logging, Monitoring & Alerts

- [ ] Log security events: logins, failed logins, password resets, permission changes and admin actions.
- [ ] **Never log** passwords, tokens, OTPs, full card numbers or other sensitive personal data.
- [ ] Use centralized logs with alerts for unusual activity (failed-login spikes, traffic spikes, 5xx spikes).
- [ ] Add error tracking (Sentry or similar) with personal data scrubbing turned on.
- [ ] Use uptime monitoring.

## 17. Backups & Disaster Recovery

- [ ] Run automated, **encrypted** daily backups, with at least one copy off-site or in a separate account.
- [ ] **Test restores** regularly; an untested backup is not a backup.
- [ ] Write down your recovery time and recovery point targets (RTO/RPO).

---

## 18. Privacy & Data Protection

India's **Digital Personal Data Protection (DPDP) Act, 2023** and its Rules apply to personal data of users in India. If you have EU users, **GDPR** applies too. *This is not legal advice; check current requirements with a lawyer.*

- [ ] **Data minimization:** collect only what you actually need.
- [ ] Publish a clear **Privacy Policy** (what you collect, why, how long you keep it, who you share it with, and how users can contact you).
- [ ] Get **clear consent** before collecting data. No pre-ticked boxes. Withdrawing consent must be as easy as giving it.
- [ ] Show a **cookie consent banner** for non-essential cookies (analytics, ads), and don't load trackers before consent.
- [ ] Let users exercise their rights: **access**, **correct**, **delete my account and data**, and **download my data**.
- [ ] Set **retention limits**: automatically delete inactive accounts and old logs after a defined period.
- [ ] **Pseudonymize or anonymize** data used for analytics.
- [ ] Have **data processing agreements** with third-party vendors (email, payments, analytics, hosting).
- [ ] Get **verifiable parental consent** if children (under 18) may use the site, as DPDP requires.
- [ ] Name a contact person or grievance officer for privacy requests.
- [ ] Have a **breach notification plan**: notify the regulator and affected users within the legal deadline.
- [ ] Use privacy-friendly analytics (for example, Plausible or self-hosted Matomo) where possible.

## 19. Payments (if applicable)

- [ ] **Never store card details.** Use a PCI-DSS compliant gateway (Razorpay, Stripe, PayU) with hosted checkout or tokenization.
- [ ] Verify payment **webhooks** with signatures on the server, and confirm the amount on the server.

## 20. Email Security

- [ ] Set up **SPF**, **DKIM** and **DMARC** records for your domain so attackers can't spoof your emails.
- [ ] Never put sensitive data in email links. Use short-lived tokens.

## 21. Incident Response Plan

1. **Detect**: alerts, user reports, or a `security.txt` contact (`/.well-known/security.txt`).
2. **Contain**: revoke compromised keys and sessions, and block the attacker's access.
3. **Investigate**: preserve logs and find the root cause.
4. **Notify**: tell affected users and authorities as the law requires. In India, **CERT-In requires reporting of certain incidents within 6 hours**.
5. **Recover and learn**: patch, restore, write a post-mortem and update this checklist.

## 22. Ongoing Security Testing

- [ ] Run automated scans in CI: **SAST** (Semgrep, CodeQL) and **DAST** (OWASP ZAP).
- [ ] Review the code against the **OWASP Top 10** and the **OWASP ASVS** checklist.
- [ ] Get a penetration test before a major launch and yearly after that.
- [ ] Do a quarterly review of user accounts, admin access and API keys.
- [ ] Give the team basic security training (phishing, password managers, 2FA on all work accounts, including the domain registrar, hosting and GitHub).

---

## Priority Order (where to start)

| Priority | Items |
|---|---|
| 🔴 **Do first** | HTTPS + HSTS · Argon2/bcrypt passwords · parameterized queries · server-side authorization checks · secure cookies · secrets out of code · rate limiting on login · security headers (Helmet) |
| 🟠 **Next** | 2FA · CSRF protection · input validation · encrypted backups · dependency scanning · WAF/CDN · logging and alerts · privacy policy and consent |
| 🟢 **Then** | Field-level encryption · E2EE for messages (if needed) · penetration testing · DPDP/GDPR user-rights tooling · incident response drills |
