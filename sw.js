/* WiseWallet service worker: network-first для HTML (свежая версия сразу) + cache-first для ассетов + web push */
const CACHE = "wisewallet-v3.11";
const ASSETS = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(
    self.registration.showNotification(d.title || "WiseWallet", {
      body: d.body || "",
      tag: d.tag || "ww-push",
      icon: "icon-192.png",
      badge: "icon-192.png"
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      return self.clients.openWindow("./");
    })
  );
});

function isHtml(req, url) {
  if (req.mode === "navigate") return true;
  const accept = req.headers.get("accept") || "";
  if (accept.includes("text/html")) return true;
  const p = url.pathname;
  return p === "/" || p.endsWith("/") || p.endsWith(".html");
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Никогда не кэшируем вызовы Supabase
  if (url.pathname.includes("/rest/v1/")) return;
  if (req.method !== "GET") return;

  // App shell (index.html и навигация): сначала сеть, офлайн — из кэша
  if (isHtml(req, url) && url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) { const clone = res.clone(); caches.open(CACHE).then((c) => c.put(req, clone)); }
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match("./index.html")))
    );
    return;
  }

  // Остальные ассеты: сначала кэш, фоновое обновление
  e.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req)
        .then((res) => {
          if (res.ok && (url.origin === location.origin || url.hostname.includes("fonts.") || url.hostname.includes("jsdelivr.net"))) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
