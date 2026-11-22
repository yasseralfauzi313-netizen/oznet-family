const CACHE_NAME = "oznet-family-v11";
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

/* ================= FIREBASE CLOUD MESSAGING (BACKGROUND PUSH) ================= */
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
    // Jika server sudah mengirim payload notification, FCM menampilkannya otomatis.
    // Fallback ini hanya berjalan untuk pesan data-only agar tidak muncul notifikasi ganda.
    if (!payload.notification && payload.data) {
      const title = payload.data.title || "OZNET FAMILY";
      const body = payload.data.body || "Ada pembaruan baru di keluarga OZNET";
      const tab = payload.data.tab || "chat";
      self.registration.showNotification(title, {
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
  const tab = data.tab || fcmData.tab || "chat";
  const targetUrl = new URL("/?tab=" + encodeURIComponent(tab), self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          client.postMessage({ type: "OPEN_TAB", tab });
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
