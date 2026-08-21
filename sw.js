// MileMark service worker — offline shell cache & push notifications.
const CACHE = "milemark-v27";
// Only the public shell is precached. Admin pages are gated server-side, and the
// API is never cached (see fetch handler) so the shared wall always stays fresh.
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./data.js",
  "./app.js",
  "./share.js",
  "./events.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./images/coffee.jpg",
  "./images/ice-bath.jpg",
  "./images/breakfast.jpg",
  "./images/dj-set.jpg",
  "./images/group-run.jpg",
  "./images/bg.jpg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
  );
  self.clients.claim();
});

// network-first for navigations (so updates show), cache-first for assets
self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // never cache the API (the shared wall must be live) or the gated admin pages
  if (
    url.origin === location.origin &&
    (url.pathname.startsWith("/api/") ||
      url.pathname === "/admin.html" ||
      url.pathname === "/admin.js" ||
      url.pathname === "/admin-login.html")
  ) {
    return; // let the browser hit the network directly
  }

  if (request.mode === "navigate") {
    e.respondWith(
      fetch(request)
        .then((res) => {
          caches.open(CACHE).then((c) => c.put("./index.html", res.clone()));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  e.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
          return res;
        })
    )
  );
});

// ---- web push notifications ----
self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { title: "MileMark", body: e.data ? e.data.text() : "We run soon." };
  }

  const title = data.title || "MileMark";
  const options = {
    body: data.body || "We run together. See you on the road.",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: data.tag || "milemark-notification",
    renotify: true,
    data: {
      url: data.url || "./",
    },
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const targetUrl = (e.notification.data && e.notification.data.url) || "./";

  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes("index.html") || client.url.endsWith("/")) {
          if ("focus" in client) return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
