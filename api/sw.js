const CACHE_NAME = "oznet-family-v21";
const BADGE_CACHE_KEY = "oznet-badge-store-v1";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./logo.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== BADGE_CACHE_KEY).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

async function readBadgeCount() {
  try {
    const cache = await caches.open(BADGE_CACHE_KEY);
    const res = await cache.match("/__badge_count__");
    if (!res) return 0;
    const txt = await res.text();
    return Math.max(0, parseInt(txt, 10) || 0);
  } catch (e) { return 0; }
}

async function writeBadgeCount(count) {
  const n = Math.max(0, Number(count) || 0);
  try {
    const cache = await caches.open(BADGE_CACHE_KEY);
    await cache.put("/__badge_count__", new Response(String(n)));
  } catch (e) {}
  try {
    if (self.navigator && typeof self.navigator.setAppBadge === "function") {
      if (n > 0) await self.navigator.setAppBadge(n);
      else if (typeof self.navigator.clearAppBadge === "function") await self.navigator.clearAppBadge();
    }
  } catch (e) {}
  return n;
}

self.addEventListener("message", (event) => {
  const d = (event && event.data) || {};
  if (d.type === "CLEAR_APP_BADGE") {
    event.waitUntil(writeBadgeCount(0));
  } else if (d.type === "SET_APP_BADGE") {
    event.waitUntil(writeBadgeCount(Number(d.count) || 0));
  }
});

// Pastikan SETIAP push yang masuk selalu menyalakan tanda merah di ikon layar utama & memicu sinkron tab terbuka
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    try {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const hasVisibleClient = clients.some((c) => c.visibilityState === "visible");
      clients.forEach((c) => {
        if (c.url.startsWith(self.location.origin)) {
          c.postMessage({ type: "SYNC_NOW" });
        }
      });
      if (!hasVisibleClient) {
        const cur = await readBadgeCount();
        await writeBadgeCount(cur + 1);
      }
    } catch (e) {}
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }

  event.respondWith(
    fetch(request, { cache: "no-store" })
      .then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return res;
      })
      .catch(() => caches.match(request))
  );
});

/* ================= FIREBASE CLOUD MESSAGING (BACKGROUND PUSH, ALARM SHOLAT & PERINGATAN TARGET) ================= */
try {
  importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
  importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

  firebase.initializeApp({
    apiKey: "AIzaSyATGjBZhUAe4FKEcwYRPLlWJyuGA-pZZWc",
    authDomain: "oznet-f368b.firebaseapp.com",
    projectId: "oznet-f368b",
    storageBucket: "oznet-f368b.firebasestorage.app",
    messagingSenderId: "677062960891",
    appId: "1:677062960891:web:e1862ca23fc5333725725e",
    measurementId: "G-XZEYQ5W4HD"
  });

  const messaging = firebase.messaging();
  messaging.onBackgroundMessage((payload) => {
    const data = (payload && payload.data) || {};

    // 1. PRIORITAS TERTINGGI: PERINGATAN LAYAR KHUSUS ANGGOTA (v21)
    if (data.type === "family_alert") {
      const alertId = data.alertId || "";
      const alertText = data.alertText || data.body || "PERINGATAN PENTING!";
      const senderName = data.senderName || "Ayah";
      const title = data.title || `🚨 PERINGATAN DARI ${senderName.toUpperCase()}!`;
      const body = data.body || `${alertText} — Buka OZNET FAMILY untuk mematikan!`;
      const targetUrl = "/?alert=" + encodeURIComponent(alertId);

      const notifPromise = self.registration.showNotification(title, {
        body,
        icon: "/logo.png",
        badge: "/logo.png",
        vibrate: [800, 200, 800, 200, 800, 200, 1000],
        tag: "oznet-family-alert-" + (alertId || Date.now()),
        renotify: true,
        requireInteraction: true,
        silent: false,
        timestamp: Date.now(),
        actions: [
          { action: "open_alert", title: "🚨 Buka OZNET & Tutup" }
        ],
        data: {
          type: "family_alert",
          alertId,
          alertText,
          senderName,
          tab: "beranda",
          url: targetUrl
        }
      });

      const wakePromise = self.clients.matchAll({ type: "window", includeUncontrolled: true })
        .then((windowClients) => {
          windowClients.forEach((client) => {
            if (client.url.startsWith(self.location.origin)) {
              client.postMessage({ type: "TRIGGER_FAMILY_ALERT", alertId });
            }
          });
        })
        .catch(() => {});

      return Promise.all([notifPromise, wakePromise]);
    }

    // 2. PRIORITAS TINGGI: ALARM WAKTU SHOLAT
    if (data.type === "prayer_alarm") {
      const prayerName = data.prayerName || "Sholat";
      const prayerTime = data.prayerTime || "";
      const offsetMin = Number(data.offsetMin) || 0;
      const isTest = data.isTest === "1";
      const title = data.title || (offsetMin > 0 ? `⏰ ${offsetMin} Menit Lagi Sholat ${prayerName}` : `🕌 Waktu Sholat ${prayerName}`);
      const body = data.body || `Jadwal ${prayerName} pukul ${prayerTime}. Ayo segera bersiap sholat!`;
      const ringUrl = data.url || `/?tab=alarm&ring=1&prayer=${encodeURIComponent(prayerName)}&time=${encodeURIComponent(prayerTime)}&offset=${offsetMin}`;

      const notifPromise = self.registration.showNotification(title, {
        body,
        icon: "/logo.png",
        badge: "/logo.png",
        vibrate: [800, 250, 800, 250, 800, 250, 1000],
        tag: isTest ? ("oznet-prayer-alarm-test-" + Date.now()) : "oznet-prayer-alarm",
        renotify: true,
        requireInteraction: true,
        silent: false,
        timestamp: Date.now(),
        actions: [
          { action: "open_alarm", title: "🔔 Buka & Bunyikan" },
          { action: "dismiss", title: "🔕 Tutup" }
        ],
        data: {
          type: "prayer_alarm",
          url: ringUrl,
          tab: "alarm",
          prayerName,
          prayerTime,
          offsetMin,
          isTest
        }
      });

      const wakeClientsPromise = self.clients.matchAll({ type: "window", includeUncontrolled: true })
        .then((windowClients) => {
          windowClients.forEach((client) => {
            if (client.url.startsWith(self.location.origin)) {
              client.postMessage({
                type: "TRIGGER_PRAYER_ALARM",
                prayerName,
                prayerTime,
                offsetMin,
                isTest
              });
            }
          });
        })
        .catch(() => {});

      return Promise.all([notifPromise, wakeClientsPromise]);
    }

    // 3. Pesan Chat / Laporan: tampilkan notifikasi heads-up jika data-only
    if (!payload.notification && payload.data) {
      const title = data.title || "OZNET FAMILY";
      const body = data.body || "Ada pembaruan baru di keluarga OZNET";
      const tab = data.tab || "chat";
      return self.registration.showNotification(title, {
        body,
        icon: "/logo.png",
        badge: "/logo.png",
        vibrate: [250, 100, 250],
        tag: "oznet-" + tab,
        renotify: true,
        silent: false,
        timestamp: Date.now(),
        data: { url: "/?tab=" + encodeURIComponent(tab), tab }
      });
    }
  });
} catch (e) {
  // Tetap berjalan normal meski sedang offline
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const fcmData = (data.FCM_MSG && data.FCM_MSG.data) ? data.FCM_MSG.data : {};
  const notifType = data.type || fcmData.type || "";

  if (event.action === "dismiss") {
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
        windowClients.forEach((client) => {
          if (client.url.startsWith(self.location.origin)) {
            client.postMessage({ type: "STOP_PRAYER_ALARM" });
          }
        });
      }).catch(() => {})
    );
    return;
  }

  const tab = data.tab || fcmData.tab || "chat";
  const alertId = data.alertId || fcmData.alertId || "";
  const prayerName = data.prayerName || fcmData.prayerName || "";
  const prayerTime = data.prayerTime || fcmData.prayerTime || "";
  const offsetMin = Number(data.offsetMin !== undefined ? data.offsetMin : (fcmData.offsetMin || 0)) || 0;
  const isTest = Boolean(data.isTest || fcmData.isTest === "1");

  let targetPath = "/?tab=" + encodeURIComponent(tab);
  if (notifType === "family_alert") {
    targetPath = "/?alert=" + encodeURIComponent(alertId);
  } else if (notifType === "prayer_alarm" && prayerName) {
    targetPath = `/?tab=alarm&ring=1&prayer=${encodeURIComponent(prayerName)}&time=${encodeURIComponent(prayerTime)}&offset=${offsetMin}`;
  }
  const targetUrl = new URL(targetPath, self.location.origin).href;

  event.waitUntil((async () => {
    if (tab === "chat") await writeBadgeCount(0);
    const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windowClients) {
      if (client.url.startsWith(self.location.origin) && "focus" in client) {
        if (notifType === "family_alert") {
          client.postMessage({ type: "TRIGGER_FAMILY_ALERT", alertId });
        } else {
          client.postMessage({ type: "OPEN_TAB", tab });
          if (notifType === "prayer_alarm" && prayerName) {
            client.postMessage({
              type: "TRIGGER_PRAYER_ALARM",
              prayerName,
              prayerTime,
              offsetMin,
              isTest
            });
          }
        }
        client.postMessage({ type: "SYNC_NOW" });
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
  })());
});
