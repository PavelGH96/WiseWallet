/* WiseWallet service worker: network-first для HTML (свежая версия сразу) + cache-first для ассетов + web push */
const CACHE = "wisewallet-v4.46";
const ASSETS = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png", "./icon-192-maskable.png", "./icon-512-maskable.png", "./apple-touch-icon.png"];

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

/* Хосты Supabase: ни кэшировать, ни перехватывать. Раньше отсекался только
   путь /rest/v1/, а запросы авторизации и служебные шли через общую ветку. */
function isSupabase(url) { return /(^|\.)supabase\.(co|in)$/i.test(url.hostname); }
function cacheable(url) {
  return url.origin === location.origin || url.hostname.includes("fonts.") || url.hostname.includes("jsdelivr.net");
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (isSupabase(url) || url.pathname.includes("/rest/v1/") || url.pathname.includes("/auth/v1/")) return;

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

  /* Остальные ассеты: отдаём из кэша, обновляем в фоне.

     v4.44. Прежняя версия заканчивалась на `return cached || fetched`, где
     `fetched` при обрыве сети превращался в `.catch(() => cached)`. Если
     записи в кэше ещё не было, оба значения оказывались undefined, и в
     respondWith уходило undefined — браузер отвечал странице сетевой
     ошибкой вместо честного «нет сети». Теперь на этот случай есть ответ
     504, а фоновое обновление держится через waitUntil: без него браузер
     вправе убить незавершённый запрос сразу после выдачи ответа. */
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        e.waitUntil(
          fetch(req)
            .then((res) => { if (res && res.ok && cacheable(url)) return caches.open(CACHE).then((c) => c.put(req, res.clone())); })
            .catch(() => {})
        );
        return cached;
      }
      return fetch(req)
        .then((res) => {
          if (res && res.ok && cacheable(url)) { const clone = res.clone(); caches.open(CACHE).then((c) => c.put(req, clone)); }
          return res;
        })
        .catch(() => new Response("", { status: 504, statusText: "Нет сети" }));
    })
  );
});
