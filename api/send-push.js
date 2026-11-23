// OZNET FAMILY api/send-push.js v21-targeted-alert
const admin = require("firebase-admin");

function initFirebaseAdmin() {
  if (admin.apps.length) return admin.app();

  const rawJson =
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.FIREBASE_ADMIN_SDK ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
    "";

  if (rawJson) {
    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch (e) {
      parsed = JSON.parse(Buffer.from(rawJson, "base64").toString("utf8"));
    }
    if (parsed.private_key) {
      parsed.private_key = String(parsed.private_key).replace(/\\n/g, "\n");
    }
    return admin.initializeApp({
      credential: admin.credential.cert(parsed)
    });
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (projectId && clientEmail && privateKey) {
    return admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey })
    });
  }

  throw new Error("Environment variable Firebase Admin (FIREBASE_SERVICE_ACCOUNT) belum diatur di Vercel.");
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    initFirebaseAdmin();
    const db = admin.firestore();
    const messaging = admin.messaging();

    const bodyObj = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const title = String(bodyObj.title || "OZNET FAMILY").slice(0, 120);
    const body = String(bodyObj.body || "Ada pembaruan baru di keluarga OZNET").slice(0, 260);
    const tab = String(bodyObj.tab || "chat");
    const type = String(bodyObj.type || "general");
    const senderId = String(bodyObj.senderId || "system");
    const senderName = String(bodyObj.senderName || "Keluarga");
    const senderToken = String(bodyObj.senderToken || "");
    const testOnly = Boolean(bodyObj.testOnly);
    const alertId = String(bodyObj.alertId || "");
    const alertText = String(bodyObj.alertText || "");
    const targetUserIds = Array.isArray(bodyObj.targetUserIds)
      ? bodyObj.targetUserIds.map((x) => String(x)).filter(Boolean)
      : [];

    let targetTokens = [];
    const tokenDocMap = new Map();

    if (testOnly) {
      if (!senderToken) {
        return res.status(400).json({ ok: false, error: "Token HP ini belum terdaftar." });
      }
      targetTokens = [senderToken];
    } else {
      const snap = await db.collection("oznet_tokens").get();
      const seen = new Set();
      snap.forEach((doc) => {
        const d = doc.data() || {};
        const tok = String(d.token || "").trim();
        const uid = String(d.userId || "").trim();
        if (!tok || seen.has(tok)) return;

        // Jika ada targetUserIds khusus (misal Peringatan hanya untuk Kakak), filter ketat HANYA untuk userId tersebut!
        if (targetUserIds.length > 0) {
          if (!targetUserIds.includes(uid)) return;
        } else {
          // Untuk chat/laporan umum, jangan kirim balik ke HP pengirim sendiri
          if (senderToken && tok === senderToken) return;
          if (senderId && senderId !== "system" && uid && uid === senderId) return;
        }

        seen.add(tok);
        targetTokens.push(tok);
        tokenDocMap.set(tok, doc.ref);
      });
    }

    if (!targetTokens.length) {
      return res.status(200).json({
        ok: true,
        sent: 0,
        failed: 0,
        note: targetUserIds.length
          ? "Belum ada token push aktif untuk anggota target yang dipilih."
          : "Tidak ada perangkat penerima aktif."
      });
    }

    const dataPayload = {
      type,
      title,
      body,
      tab,
      senderId,
      senderName,
      url: type === "family_alert"
        ? "/?alert=" + encodeURIComponent(alertId)
        : "/?tab=" + encodeURIComponent(tab)
    };
    if (alertId) dataPayload.alertId = alertId;
    if (alertText) dataPayload.alertText = alertText;

    // Untuk family_alert: kirim data-only high-priority agar sw.js selalu menampilkan notif menempel (requireInteraction) + getar panjang!
    const messagePayload = type === "family_alert"
      ? {
          tokens: targetTokens,
          data: dataPayload,
          android: { priority: "high" },
          webpush: {
            headers: {
              Urgency: "high",
              TTL: "86400"
            }
          }
        }
      : {
          tokens: targetTokens,
          notification: { title, body },
          data: dataPayload,
          android: {
            priority: "high",
            notification: {
              sound: "default",
              priority: "max"
            }
          },
          webpush: {
            headers: {
              Urgency: "high",
              TTL: "86400"
            },
            notification: {
              title,
              body,
              icon: "/logo.png",
              badge: "/logo.png",
              renotify: true,
              tag: "oznet-" + tab
            },
            fcmOptions: {
              link: dataPayload.url
            }
          }
        };

    const batchRes = await messaging.sendEachForMulticast(messagePayload);

    // Bersihkan otomatis token kedaluwarsa / tidak valid dari Firestore
    const cleanupPromises = [];
    batchRes.responses.forEach((r, idx) => {
      if (!r.success && r.error) {
        const code = r.error.code || "";
        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token"
        ) {
          const ref = tokenDocMap.get(targetTokens[idx]);
          if (ref) cleanupPromises.push(ref.delete().catch(() => {}));
        }
      }
    });
    if (cleanupPromises.length) await Promise.all(cleanupPromises);

    return res.status(200).json({
      ok: true,
      sent: batchRes.successCount,
      failed: batchRes.failureCount,
      targeted: targetUserIds
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: (err && err.message) ? err.message : String(err)
    });
  }
};
