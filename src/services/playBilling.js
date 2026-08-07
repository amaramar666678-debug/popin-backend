```javascript
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const { prisma } = require("../middleware/prisma");

// ─────────────────────────────────────────────────────────────────────────────
// Configuration — edit to match your Google Play Console.
// Product IDs must be EXACTLY the same ids defined in Play Console
// (Monetize → Products / Subscriptions).
// ─────────────────────────────────────────────────────────────────────────────
const PACKAGE_NAME = "com.popin.app";

// Server-side catalog is the single source of truth for what a purchase grants.
// The client never decides the amount — only the productId + purchaseToken.
const PRODUCT_CATALOG = {
  // In-app products (consumables)
  hearts_pack_70: { kind: "product", grant: { hearts: 70 } },
  hearts_pack_100: { kind: "product", grant: { hearts: 100 } },
  hearts_pack_300: { kind: "product", grant: { hearts: 300 } },
  messages_pack_20: { kind: "product", grant: { message_credits: 20 } },
  super_likes_pack_10: { kind: "product", grant: { super_likes: 10 } },
  super_likes_pack_50: { kind: "product", grant: { super_likes: 50 } },
  rewinds_pack_10: { kind: "product", grant: { rewind_credits: 10 } },
  eye_credits_pack_1: { kind: "product", grant: { eye_credits: 1 } },

  // Subscriptions (auto-renewing)
  premium_monthly: { kind: "subscription", tier: "premium" },
  premium_yearly: { kind: "subscription", tier: "premium" },
};

const SERVICE_ACCOUNT_PATH =
  process.env.SERVICE_ACCOUNT_PATH ||
  path.join(__dirname, "..", "..", "service-account.json");

// ── Custom typed errors (route layer maps `status` → HTTP code) ──
function BillingError(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.isBillingError = true;
  return err;
}

let auth = null;
let androidpublisher = null;

function getAndroidPublisher() {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    throw BillingError(
      "BILLING_NOT_CONFIGURED",
      "Google Play billing is not configured on the server",
      503
    );
  }

  if (!auth) {
    auth = new google.auth.GoogleAuth({
      keyFile: SERVICE_ACCOUNT_PATH,
      scopes: [
        "https://www.googleapis.com/auth/androidpublisher",
      ],
    });

    androidpublisher = google.androidpublisher({
      version: "v3",
      auth,
    });
  }

  return androidpublisher;
}

function parseGoogleApiError(error) {
  // GaxiosError shape:
  // {
  //   code,
  //   status,
  //   response: {
  //     status,
  //     data: {
  //       error: {
  //         code,
  //         status,
  //         message,
  //         errors: [{ reason }]
  //       }
  //     }
  //   }
  // }

  const httpStatus =
    error?.response?.status || error?.code;

  const apiError =
    error?.response?.data?.error;

  const reason =
    apiError?.errors?.[0]?.reason ||
    apiError?.status;

  if (
    httpStatus === 404 ||
    reason === "purchaseTokenNotFound" ||
    reason === "purchaseTokenInvalid"
  ) {
    return BillingError(
      "INVALID_PURCHASE_TOKEN",
      "Purchase token is invalid or has already been consumed",
      400
    );
  }

  if (httpStatus === 403) {
    // API disabled in GCP or service account lacks authorization for this app.
    return BillingError(
      "GOOGLE_FORBIDDEN",
      "Billing service account is not authorized for this app",
      503
    );
  }

  return null;
}

/**
 * Verifies a purchase against the Google Play Developer API.
 * Returns normalized data; throws a BillingError on any invalid state.
 */
async function verifyPurchase(productId, purchaseToken) {
  const item = PRODUCT_CATALOG[productId];

  if (!item) {
    throw BillingError(
      "UNKNOWN_PRODUCT",
      "Unknown productId",
      400
    );
  }

  const api = getAndroidPublisher();

  if (item.kind === "subscription") {
    const response =
      await api.purchases.subscriptions
        .get({
          packageName: PACKAGE_NAME,
          subscriptionId: productId,
          token: purchaseToken,
        })
        .catch((error) => {
          throw parseGoogleApiError(error) || error;
        });

    const data = response.data;

    // Payment pending → user has not actually paid yet.
    if (data.paymentState === 0) {
      throw BillingError(
        "PURCHASE_PENDING",
        "Subscription payment is pending",
        400
      );
    }

    // No expiry or already expired → not a usable subscription.
    if (
      !data.expiryTimeMillis ||
      parseInt(data.expiryTimeMillis, 10) <= Date.now()
    ) {
      throw BillingError(
        "SUBSCRIPTION_EXPIRED",
        "Subscription is not active or is expired",
        400
      );
    }

    return {
      kind: "subscription",
      item,
      expiryMs: parseInt(
        data.expiryTimeMillis,
        10
      ),
      orderId: data.orderId,
    };
  }

  // In-app product
  const response =
    await api.purchases.products
      .get({
        packageName: PACKAGE_NAME,
        productId,
        token: purchaseToken,
      })
      .catch((error) => {
        throw parseGoogleApiError(error) || error;
      });

  const data = response.data;

  // purchaseState 0 = purchased (payment completed).
  // 1 = canceled, 2 = pending.
  if (data.purchaseState !== 0) {
    throw BillingError(
      "PURCHASE_NOT_COMPLETE",
      "Purchase is not completed by Google",
      400
    );
  }

  return {
    kind: "product",
    item,
    orderId: data.orderId,
  };
}

/**
 * Secure grant pipeline:
 *
 * 1. Idempotency check (purchaseToken must be unique in the ledger).
 * 2. Verify with Google Play API (server is the source of truth for amounts).
 * 3. Write ledger row + credit the user inside a single DB transaction.
 *
 * The UNIQUE constraint on purchaseToken is the final guard against
 * concurrent replays (P2002 → treated as "token already used").
 */
async function verifyAndGrantPurchase(
  { userId, productId, purchaseToken, orderId },
  verify = verifyPurchase
) {
  if (!productId || !purchaseToken) {
    throw BillingError(
      "MISSING_FIELDS",
      "productId and purchaseToken are required",
      400
    );
  }

  if (!PRODUCT_CATALOG[productId]) {
    throw BillingError(
      "UNKNOWN_PRODUCT",
      "Unknown productId",
      400
    );
  }

  const existing =
    await prisma.purchaseLedger.findUnique({
      where: { purchaseToken },
    });

  if (existing) {
    throw BillingError(
      "PURCHASE_TOKEN_USED",
      "This purchase token has already been used",
      400
    );
  }

  const {
    kind,
    item,
    expiryMs,
    orderId: googleOrderId,
  } = await verify(productId, purchaseToken);

  const amount =
    kind === "product"
      ? Object.values(item.grant).reduce(
          (sum, value) => sum + (value || 0),
          0
        )
      : 0;

  try {
    return await prisma.$transaction(async (tx) => {
      const ledger =
        await tx.purchaseLedger.create({
          data: {
            userId,
            productId,
            purchaseToken,
            orderId:
              googleOrderId ||
              orderId ||
              "UNKNOWN_ORDER",
            kind,
            amount,
            status: "COMPLETED",
          },
        });

      let user;

      if (kind === "subscription") {
        user = await tx.user.update({
          where: { id: userId },
          data: {
            is_premium: true,
            subscription_tier: item.tier,
            subscription_expires_at:
              new Date(expiryMs),
          },
        });
      } else {
        const data = {};

        for (const [field, value] of Object.entries(
          item.grant
        )) {
          if (value > 0) {
            data[field] = {
              increment: value,
            };
          }
        }

        user = await tx.user.update({
          where: { id: userId },
          data,
        });
      }

      return {
        ledger,
        user,
      };
    });
  } catch (error) {
    // P2002 = unique constraint violation on purchaseToken
    // → concurrent replay.
    if (
      error?.code === "P2002" ||
      error?.meta?.target?.includes?.(
        "purchaseToken"
      )
    ) {
      throw BillingError(
        "PURCHASE_TOKEN_USED",
        "This purchase token has already been used",
        400
      );
    }

    throw error;
  }
}

module.exports = {
  PACKAGE_NAME,
  PRODUCT_CATALOG,
  verifyPurchase,
  verifyAndGrantPurchase,
};
```
