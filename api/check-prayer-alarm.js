const admin = require("firebase-admin");

const DEFAULT_ALARM = {
  enabled: true,
  offsetMinutes: 10,
  sound: "sirine",
  prayers: { Subuh: true, Dzuhur: true, Ashar: true, Maghrib: true, Isya: true },
  location: { name: "Rangkasbitung, Lebak", lat: -6.3592, lng: 106.2494, tz: 7 }
};

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
      throw new Error("Format JSON pada FIREBASE_SERVICE_ACCOUNT tidak valid.");
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

function mergeAlarm(base, incoming) {
  const out = JSON.parse(JSON.stringify(base));
  if (incoming && typeof incoming === "object") {
    if (typeof incoming.enabled === "boolean") out.enabled = incoming.enabled;
    if (incoming.offsetMinutes !== undefined && incoming.offsetMinutes !== null && !isNaN(Number(incoming.offsetMinutes))) {
      out.offsetMinutes = Number(incoming.offsetMinutes);
    }
    if (incoming.sound) out.sound = String(incoming.sound);
    if (incoming.prayers && typeof incoming.prayers === "object") {
      out.prayers = Object.assign({}, out.prayers, incoming.prayers);
    }
    if (incoming.location && typeof incoming.location === "object") {
      out.location = Object.assign({}, out.location, incoming.location);
      out.location.lat = Number(out.location.lat);
      out.location.lng = Number(out.location.lng);
      out.location.tz = Number(out.location.tz);
    }
  }
  return out;
}

function getLocalClockParts(tz) {
  const shifted = new Date(Date.now() + tz * 3600000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth(); // 0-indexed
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const startOfYearUtc = Date.UTC(year, 0, 0);
  const todayUtc = Date.UTC(year, month, day);
  const dayOfYear = Math.floor((todayUtc - startOfYearUtc) / 86400000);
  const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const hmNow = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return { year, month, day, hour, minute, dayOfYear, curMin: hour * 60 + minute, dateKey, hmNow };
}

function computePrayerTimesFromDayOfYear(D, lat, lng, tz) {
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;
  const B = (360 / 365) * (D - 81) * rad;
  const EoT = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  const decl = 23.45 * Math.sin((360 / 365) * (284 + D) * rad);
  const noon = 12 + tz - lng / 15 - EoT / 60;

  function hourAngle(angle) {
    const cosH = (Math.sin(angle * rad) - Math.sin(lat * rad) * Math.sin(decl * rad)) /
                 (Math.cos(lat * rad) * Math.cos(decl * rad));
    if (cosH > 1 || cosH < -1) return 0;
    return Math.acos(cosH) * deg / 15;
  }

  const subuh = noon - hourAngle(-20) + 2 / 60;
  const dzuhur = noon + 2 / 60;
  const asharAngle = Math.atan(1 / (1 + Math.tan(Math.abs(lat - decl) * rad))) * deg;
  const ashar = noon + hourAngle(asharAngle) + 2 / 60;
  const maghrib = noon + hourAngle(-0.833) + 2 / 60;
  const isya = noon + hourAngle(-18) + 2 / 60;

  const toHM = (h) => {
    const total = Math.round(((h % 24) + 24) % 24 * 60);
    const hh = String(Math.floor(total / 60) % 24).padStart(2, "0");
    const mm = String(total % 60).padStart(2, "0");
    return `${hh}:${mm}`;
  };
  return {
    Subuh: toHM(subuh),
    Dzuhur: toHM(dzuhur),
    Ashar: toHM(ashar),
    Maghrib: toHM(maghrib),
    Isya: toHM(isya)
  };
}

function timeToMinutes(hm) {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

function minutesToHM(totalMin) {
  const m = ((totalMin % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

async function dispatchAlarmPushToAllDevices(fb, db, { prayerName, prayerTime, offsetMin, locationName, dateKey, isTest = false }) {
  const snap = await db.collection("oznet_tokens").get();
  const tokenDocMap = new Map();
  snap.forEach((doc) => {
    const d = doc.data();
    if (d && d.token) tokenDocMap.set(d.token, doc.id);
  });

  const tokens = Array.from(tokenDocMap.keys());
  if (!tokens.length) {
    return { sent: 0, failed: 0, tokensCount: 0, note: "Belum ada HP yang mengaktifkan notifikasi (ikon lonceng)." };
  }

  const title = isTest
    ? `🔔 TES ALARM SHOLAT (${prayerName})`
    : (offsetMin > 0 ? `⏰ ${offsetMin} Menit Lagi Sholat ${prayerName}` : `🕌 Waktu Sholat ${prayerName}`);
  const body = isTest
    ? `Tes Alarm Background berhasil! Jika HP sedang terkunci/ditutup, notifikasi alarm ini otomatis berbunyi & bergetar.`
    : `Jadwal ${prayerName} pukul ${prayerTime} (${locationName}). Ayo segera bersiap sholat!`;

  const ringUrl = `/?tab=alarm&ring=1&prayer=${encodeURIComponent(prayerName)}&time=${encodeURIComponent(prayerTime)}&offset=${offsetMin}`;

  // Data-only high-priority payload agar sw.js onBackgroundMessage SELALU dijalankan:
  // 1) Menampilkan notifikasi alarm keras + getar panjang saat aplikasi ditutup
  // 2) Membangunkan tab di latar belakang (background) agar langsung membunyikan sirine/bedug
  const message = {
    tokens,
    data: {
      type: "prayer_alarm",
      title,
      body,
      prayerName: String(prayerName),
      prayerTime: String(prayerTime),
      offsetMin: String(offsetMin),
      dateKey: String(dateKey),
      isTest: isTest ? "1" : "0",
      tab: "alarm",
      url: ringUrl
    },
    android: {
      priority: "high",
      ttl: 300000
    },
    webpush: {
      headers: {
        Urgency: "high",
        TTL: "300"
      },
      fcmOptions: {
        link: ringUrl
      }
    }
  };

  const result = await fb.messaging().sendEachForMulticast(message);

  // Bersihkan token mati secara otomatis
  const cleanupPromises = [];
  result.responses.forEach((resp, idx) => {
    if (!resp.success && resp.error) {
      const code = resp.error.code || "";
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
      ) {
        const docId = tokenDocMap.get(tokens[idx]);
        if (docId) {
          cleanupPromises.push(db.collection("oznet_tokens").doc(docId).delete().catch(() => {}));
        }
      }
    }
  });
  if (cleanupPromises.length) await Promise.all(cleanupPromises);

  return { sent: result.successCount, failed: result.failureCount, tokensCount: tokens.length };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const fb = getFirebaseAdmin();
    const db = fb.firestore();

    // Ambil konfigurasi alarm terbaru yang disimpan Admin dari Cloud Firestore
    const cfgSnap = await db.collection("oznet_config").doc("main").get();
    const rawAlarm = cfgSnap.exists ? (cfgSnap.data().alarm || {}) : {};
    const alarm = mergeAlarm(DEFAULT_ALARM, rawAlarm);

    const loc = alarm.location || DEFAULT_ALARM.location;
    const tz = isNaN(Number(loc.tz)) ? 7 : Number(loc.tz);
    const lat = isNaN(Number(loc.lat)) ? -6.3592 : Number(loc.lat);
    const lng = isNaN(Number(loc.lng)) ? 106.2494 : Number(loc.lng);
    const offset = Number(alarm.offsetMinutes) || 0;

    const clock = getLocalClockParts(tz);
    const times = computePrayerTimesFromDayOfYear(clock.dayOfYear, lat, lng, tz);

    // Hitung jadwal bunyi semua waktu sholat hari ini untuk informasi diagnostik
    const alarmSchedule = {};
    ["Subuh", "Dzuhur", "Ashar", "Maghrib", "Isya"].forEach((p) => {
      const tMin = (timeToMinutes(times[p]) - offset + 1440) % 1440;
      alarmSchedule[p] = {
        prayerTime: times[p],
        alarmTime: minutesToHM(tMin),
        active: Boolean(alarm.prayers && alarm.prayers[p])
      };
    });

    // Mode Tes Manual: https://oznet-family.vercel.app/api/check-prayer-alarm?test=1
    const isTestReq = req.query && (req.query.test === "1" || req.query.test === "true");
    if (isTestReq) {
      const dispatchRes = await dispatchAlarmPushToAllDevices(fb, db, {
        prayerName: "Maghrib",
        prayerTime: times.Maghrib,
        offsetMin: offset,
        locationName: loc.name || "Rangkasbitung",
        dateKey: clock.dateKey,
        isTest: true
      });
      return res.status(200).json({
        ok: true,
        mode: "test",
        nowLocal: `${clock.dateKey} ${clock.hmNow} (UTC+${tz})`,
        location: loc.name,
        offsetMinutes: offset,
        alarmSchedule,
        pushResult: dispatchRes
      });
    }

    if (!alarm.enabled) {
      return res.status(200).json({
        ok: true,
        triggered: false,
        reason: "Alarm otomatis sedang dimatikan oleh Admin.",
        nowLocal: `${clock.dateKey} ${clock.hmNow} (UTC+${tz})`,
        alarmSchedule
      });
    }

    const triggeredList = [];

    for (const prayerName of ["Subuh", "Dzuhur", "Ashar", "Maghrib", "Isya"]) {
      if (!alarm.prayers || !alarm.prayers[prayerName]) continue;
      const prayerTime = times[prayerName];
      const targetMin = (timeToMinutes(prayerTime) - offset + 1440) % 1440;

      // Jendela 4 menit (0..4) agar ping cron 1-5 menit tidak pernah terlewat
      let diffMin = clock.curMin - targetMin;
      if (diffMin < -720) diffMin += 1440;

      if (diffMin >= 0 && diffMin <= 4) {
        const lockDocId = `alarm_push_${clock.dateKey}_${prayerName}_${offset}`;
        const lockRef = db.collection("oznet_config").doc(lockDocId);

        // Kunci atomik via transaksi Firestore agar hanya terkirim 1x per waktu sholat
        const claimed = await db.runTransaction(async (tx) => {
          const snap = await tx.get(lockRef);
          if (snap.exists) return false;
          tx.set(lockRef, {
            sentAt: Date.now(),
            by: "server-cron",
            prayerName,
            prayerTime,
            offsetMin: offset,
            localTime: `${clock.dateKey} ${clock.hmNow}`
          });
          return true;
        });

        if (claimed) {
          const pushResult = await dispatchAlarmPushToAllDevices(fb, db, {
            prayerName,
            prayerTime,
            offsetMin: offset,
            locationName: loc.name || "Rangkasbitung",
            dateKey: clock.dateKey,
            isTest: false
          });
          triggeredList.push({ prayerName, prayerTime, offsetMin: offset, pushResult });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      status: "Server Alarm Sholat OZNET FAMILY aktif",
      nowLocal: `${clock.dateKey} ${clock.hmNow} (UTC+${tz})`,
      location: loc.name,
      offsetMinutes: offset,
      alarmSchedule,
      triggered: triggeredList.length > 0,
      triggeredList
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Gagal memeriksa jadwal alarm sholat."
    });
  }
};
