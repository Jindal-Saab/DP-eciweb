// Deployment mode. APP_MODE=training runs a practice environment: every response says so, the
// screens show a banner, and nothing that could carry real personal data or official results can
// be connected (approved government data sources, official result feeds).
export const APP_MODE = process.env.APP_MODE === "training" ? "training" : "live";
export const isTraining = () => (process.env.APP_MODE === "training");

/**
 * Configuration checks run once at start-up. In production, a weak token secret or a demo switch
 * left on stops the server rather than running unsafely.
 */
export const checkConfig = (env = process.env) => {
    const problems = [];
    if (env.NODE_ENV === "production") {
        if (!env.ACCESS_TOKEN_SECRET || env.ACCESS_TOKEN_SECRET.length < 32) problems.push("ACCESS_TOKEN_SECRET must be at least 32 characters in production.");
        if (env.PERSONA_DEMO_MODE === "true" && env.APP_MODE !== "training") problems.push("PERSONA_DEMO_MODE must not be on in a live production deployment.");
        if (env.STEP_UP_REQUIRED === "false" && env.APP_MODE !== "training") problems.push("STEP_UP_REQUIRED must not be turned off in a live production deployment.");
        if (!env.PACKAGE_SIGNING_KEY) problems.push("PACKAGE_SIGNING_KEY (an Ed25519 private key) is required in production to sign polling-station packages.");
        if (!env.CLIENT_URL) problems.push("CLIENT_URL must list the allowed web origins in production.");
    }
    return problems;
};

/**
 * Settings that are allowed but weaken security in a live production deployment. They are printed
 * at start-up as warnings (not refused, so a demonstration deployment keeps working).
 */
export const configWarnings = (env = process.env) => {
    const warnings = [];
    if (env.NODE_ENV !== "production" || env.APP_MODE === "training") return warnings;
    if (env.ENABLE_DEMO_OTP_NOTIFICATIONS === "true") warnings.push("ENABLE_DEMO_OTP_NOTIFICATIONS is on: anyone who knows an EPIC number can read its sign-in code from /api/v1/notifications. Turn it off once a real SMS gateway is connected.");
    if (!env.AADHAAR_ENCRYPTION_KEY) warnings.push("AADHAAR_ENCRYPTION_KEY is not set: only the last 4 Aadhaar digits are kept (the full number cannot be stored encrypted).");
    if (!env.PERSONA_WEBHOOK_SECRET) warnings.push("PERSONA_WEBHOOK_SECRET is not set: Persona webhooks cannot be verified and are refused.");
    return warnings;
};
