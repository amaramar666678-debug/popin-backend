const fs = require("fs");
const path = require("path");

let getMessaging = null;
let initialized = false;

function initFirebase() {
  const serviceAccountPath = path.join(__dirname, "../../service-account.json");
  if (!fs.existsSync(serviceAccountPath)) {
    console.warn("[fcm] service-account.json not found — push notifications disabled");
    return;
  }
  try {
    require("firebase-admin");
    const { getMessaging: gm } = require("firebase-admin/messaging");
    const admin = require("firebase-admin");
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
    admin.initializeApp({ credential: admin.cert(serviceAccount) });
    getMessaging = gm;
    initialized = true;
    console.log("[fcm] Firebase initialized");
  } catch (err) {
    console.error("[fcm] Failed to initialize Firebase:", err.message);
  }
}

async function sendPush({ token, title, body, data }) {
  if (!initialized || !getMessaging) return;
  try {
    const message = {
      token,
      notification: { title, body },
      data: data || {},
      android: { priority: "high" },
    };
    await getMessaging().send(message);
  } catch (err) {
    console.error("[fcm] send error:", err.message);
  }
}

async function sendPushToUser({ userId, title, body, data, prisma }) {
  if (!initialized || !getMessaging) return;
  try {
    const devices = await prisma.device.findMany({ where: { userId } });
    for (const device of devices) {
      await sendPush({ token: device.fcmToken, title, body, data });
    }
  } catch (err) {
    console.error("[fcm] sendPushToUser error:", err.message);
  }
}

module.exports = { initFirebase, sendPush, sendPushToUser };
