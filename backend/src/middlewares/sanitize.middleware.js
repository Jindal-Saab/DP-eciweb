// Removes keys that no legitimate request needs and that attacks rely on, from the JSON or form
// body and the query string, before any route sees them:
//   __proto__, constructor, prototype   prototype pollution (changing every object in the process)
//   keys starting with "$"              MongoDB operator injection ({ "epic": { "$ne": null } })
// Values are not changed: validation of each field stays with the route that uses it.

const BLOCKED = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 32;

export const isDangerousKey = (key) => BLOCKED.has(key) || key.startsWith("$");

/** Returns a copy of `value` without dangerous keys (and counts how many were removed). */
export const stripDangerousKeys = (value, stats = { removed: 0 }, depth = 0) => {
    if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => stripDangerousKeys(v, stats, depth + 1));
    // Buffers, dates and other non-plain objects are left as they are.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out = {};
    for (const key of Object.keys(value)) {
        if (isDangerousKey(key)) { stats.removed += 1; continue; }
        out[key] = stripDangerousKeys(value[key], stats, depth + 1);
    }
    return out;
};

export const sanitizeRequest = (req, res, next) => {
    const stats = { removed: 0 };
    if (req.body && typeof req.body === "object") req.body = stripDangerousKeys(req.body, stats);
    // Express 5 computes req.query in a getter on every access, so the clean copy is pinned on the request.
    const query = stripDangerousKeys(req.query, stats);
    Object.defineProperty(req, "query", { value: query, writable: true, configurable: true, enumerable: true });
    if (stats.removed) console.warn(`Sanitised ${stats.removed} unsafe key(s) from ${req.method} ${req.path}`);
    next();
};
