const express = require("express");
const router = express.Router();

const { authenticateToken } = require("../middleware/auth");
const { safeHttpError } = require("../helpers/http_error");
const { verifyAndGrantPurchase } = require("../services/playBilling");

// POST /billing/verify — verify a Google Play purchase and grant the reward.
router.post("/verify", authenticateToken, async (req, res) => {
  const { productId, purchaseToken, orderId } = req.body || {};
  if (!productId || !purchaseToken) {
    return res
      .status(400)
      .json({ success: false, error: "productId and purchaseToken are required" });
  }

  try {
    const { user } = await verifyAndGrantPurchase({
      userId: req.user.id,
      productId,
      purchaseToken,
      orderId,
    });
    res.json({
      success: true,
      message: "Purchase verified and credited",
      user,
    });
  } catch (error) {
    if (error?.isBillingError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    console.error("[billing/verify]", error?.message || error);
    safeHttpError(res, error, "billing/verify");
  }
});

module.exports = router;
