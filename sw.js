/**
 * Service Worker OZNET FAMILY
 * Strategi: Network-First untuk halaman utama & aset penting agar aplikasi
 * selalu otomatis mengambil versi terbaru dari Vercel (Auto-Update),
 * sekaligus mendukung instalasi PWA (beforeinstallprompt) & cadangan offline.
 */

const CACHE_NAME = "oznet-family-pwa-v2";
const CORE_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/logo.png"
];

// 1. INSTALL: Pre-cache aset inti & langsung aktif tanpa menunggu tab ditutup
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// 2. ACTIVATE: Hapus cache versi lama & langsung ambil kendali semua halaman aktif
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// 3. MESSAGE: Izinkan halaman memicu aktivasi instan bila ada versi SW baru
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// 4. FETCH: Network-First agar perubahan di GitHub/Vercel langsung tampil otomatis
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Abaikan request lintas domain (seperti API GPS Nominatim, Google Fonts, CDN)
  if (url.origin !== self.location.origin) return;

  // Abaikan pengecekan versi auto-update agar tidak tersangkut cache
  if (url.searchParams.has("_ozchk")) return;

  event.respondWith(
    fetch(request, { cache: "no-cache" })
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
        }
        return networkResponse;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          if (request.mode === "navigate") {
            return caches.match("/index.html");
          }
          return undefined;
        })
      )
  );
});
