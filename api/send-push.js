const admin = require("firebase-admin");

function getFirebaseAdmin() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
      throw new Error("Environment Variable FIREBASE_SERVICE_ACCOUNT belum dipasang di Vercel.");
    }
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(raw.trim());
    } catch (err) {
      throw new Error("Format JSON pada FIREBASE_SERVICE_ACCOUNT tidak valid. Pastikan seluruh isi file .json dari Firebase disalin utuh.");
    }
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
  return admin;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Health check via browser: https://oznet-family.vercel.app/api/send-push
  if (req.method === "GET") {
    try {
      const fb = getFirebaseAdmin();
      return res.status(200).json({
        ok: true,
        status: "FCM Push Server OZNET FAMILY aktif",
        projectId: fb.app().options.credential ? "oznet-f368b" : "configured"
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method tidak diizinkan." });
  }

  try {
    const fb = getFirebaseAdmin();
    const db = fb.firestore();
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    const title = String(body.title || "OZNET FAMILY").slice(0, 100);
    const textBody = String(body.body || "Ada pembaruan baru di keluarga OZNET").slice(0, 220);
    const tab = String(body.tab || "chat");
    const senderId = String(body.senderId || "");
    const senderToken = String(body.senderToken || "");
    const testOnly = Boolean(body.testOnly);

    const tokenDocMap = new Map();
    if (testOnly && senderToken) {
      tokenDocMap.set(senderToken, null);
    } else {
      const snap = await db.collection("oznet_tokens").get();
      snap.forEach((doc) => {
        const d = doc.data();
        if (d && d.token && d.token !== senderToken) {
          tokenDocMap.set(d.token, doc.id);
        }
      });
    }

    const tokens = Array.from(tokenDocMap.keys());
    if (!tokens.length) {
      return res.status(200).json({
        ok: true,
        sent: 0,
        failed: 0,
        message: "Belum ada perangkat keluarga lain yang mengaktifkan notifikasi."
      });
    }

    const link = "/?tab=" + encodeURIComponent(tab);
    const message = {
      tokens,
      notification: {
        title,
        body: textBody
      },
      data: {
        title,
        body: textBody,
        tab,
        senderId,
        url: link
      },
      webpush: {
        headers: {
          Urgency: "high",
          TTL: "86400"
        },
        notification: {
          title,
          body: textBody,
          icon: "/logo.png",
          badge: "/logo.png",
          vibrate: [200, 100, 200],
          tag: "oznet-" + tab,
          renotify: true
        },
        fcmOptions: {
          link
        }
      }
    };

    const result = await fb.messaging().sendEachForMulticast(message);

    const cleanupPromises = [];
    result.responses.forEach((resp, idx) => {
      if (!resp.success && resp.error) {
        const code = resp.error.code || "";
        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token"
        ) {
          const deadToken = tokens[idx];
          const docId = tokenDocMap.get(deadToken);
          if (docId) {
            cleanupPromises.push(db.collection("oznet_tokens").doc(docId).delete().catch(() => {}));
          }
        }
      }
    });
    if (cleanupPromises.length) await Promise.all(cleanupPromises);

    return res.status(200).json({
      ok: true,
      sent: result.successCount,
      failed: result.failureCount
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Gagal mengirim push notification." });
  }
};
