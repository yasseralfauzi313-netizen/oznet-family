const CACHE_NAME = "oznet-family-v12";
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
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Jangan cegat request non-GET, endpoint API Vercel (/api/*), atau server eksternal (Firebase)
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }

  // Network-First agar pembaruan index.html di Vercel selalu langsung tampil
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

/* ================= FIREBASE CLOUD MESSAGING (BACKGROUND PUSH & ALARM SHOLAT) ================= */
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

    // 1. PRIORITAS TINGGI: ALARM WAKTU SHOLAT (Aplikasi ditutup atau di layar belakang)
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

      // Bangunkan tab/PWA yang sedang berjalan di belakang layar agar langsung membunyikan sirine/bedug
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

    // 2. Fallback untuk pesan chat/laporan data-only (hindari notifikasi ganda jika payload.notification sudah ada)
    if (!payload.notification && payload.data) {
      const title = data.title || "OZNET FAMILY";
      const body = data.body || "Ada pembaruan baru di keluarga OZNET";
      const tab = data.tab || "chat";
      return self.registration.showNotification(title, {
        body,
        icon: "/logo.png",
        badge: "/logo.png",
        vibrate: [200, 100, 200],
        tag: "oznet-" + tab,
        renotify: true,
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

  // Jika pengguna menekan tombol "🔕 Tutup" pada notifikasi alarm
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
  const prayerName = data.prayerName || fcmData.prayerName || "";
  const prayerTime = data.prayerTime || fcmData.prayerTime || "";
  const offsetMin = Number(data.offsetMin !== undefined ? data.offsetMin : (fcmData.offsetMin || 0)) || 0;
  const isTest = Boolean(data.isTest || fcmData.isTest === "1");

  let targetPath = "/?tab=" + encodeURIComponent(tab);
  if (notifType === "prayer_alarm" && prayerName) {
    targetPath = `/?tab=alarm&ring=1&prayer=${encodeURIComponent(prayerName)}&time=${encodeURIComponent(prayerTime)}&offset=${offsetMin}`;
  }
  const targetUrl = new URL(targetPath, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
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
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
