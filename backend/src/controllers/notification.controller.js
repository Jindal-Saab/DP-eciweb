
import { getNotifications } from "../services/otp.service.js";
import { ApiError } from "../utils/ApiErrors.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const getUserNotifications = asyncHandler(async (req, res) => {
    // There is no SMS gateway, so this demo feed (shown on /phone) is the only way to read a code.
    // It is off unless ENABLE_DEMO_OTP_NOTIFICATIONS=true, including in production.
    if (process.env.ENABLE_DEMO_OTP_NOTIFICATIONS !== "true") {
        throw new ApiError(403, "Demo OTP notifications are disabled.");
    }

    const epic = String(req.query.epic ?? "").trim().toUpperCase();

    if (!/^[A-Z]{3}\d{7}$/.test(epic)) {
        throw new ApiError(400, "A valid EPIC number is required.");
    }

    res.status(200).json({
        success: true,
        data: {
            notifications: await getNotifications(epic)
        }
    });
});
