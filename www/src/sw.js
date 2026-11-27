const CACHE_NAME = "ys-play-v1";
const PLAYGROUND_PATH = "/play/";
const ASSET_PATTERN = new RegExp(
  "<(?:link|script|img)\\b[^>]*?\\s(?:href|src)=\"([^\"]+)\"" +
  "|\\sdata-[a-z-]+-url=\"([^\"]+)\"",
  "g",
);

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  const response = await fetch(PLAYGROUND_PATH, {cache: "no-cache"});
  if (!response.ok) {
    throw new Error(`Unable to load Playground: ${response.status}`);
  }
  const html = await response.clone().text();
  await cache.put(PLAYGROUND_PATH, response);
  const urls = new Set();
  for (const match of html.matchAll(ASSET_PATTERN)) {
    const url = new URL(
      match[1] || match[2],
      new URL(PLAYGROUND_PATH, location.href),
    );
    const file = /\.[a-z0-9]+$/i.test(url.pathname) &&
      !/\.(?:html|xml)$/i.test(url.pathname);
    if (url.origin === location.origin && file) urls.add(url.href);
  }
  await Promise.allSettled([...urls].map((url) => cache.add(url)));
}

async function networkFirst(event) {
  const {request} = event;
  const cache = await caches.open(CACHE_NAME);
  const navigate = request.mode === "navigate";
  const key = navigate ? new URL(request.url).pathname : request;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cached = await cache.match(key);
      const etag = response.headers.get("etag");
      if (!cached || !etag || cached.headers.get("etag") !== etag) {
        event.waitUntil(cache.put(key, response.clone()));
      }
    }
    return response;
  } catch (error) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const {request} = event;
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== location.origin) return;
  event.respondWith(networkFirst(event));
});
