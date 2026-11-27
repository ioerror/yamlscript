const CACHE_NAME = "ys-play-v1";
const PLAYGROUND_PATH = "/play/";
const NETWORK_TIMEOUT = 3000;
const ASSET_PATTERN = new RegExp(
  "<(?:link|script|img)\\b[^>]*?\\s(?:href|src)=\"([^\"]+)\"" +
  "|\\sdata-[a-z-]+-url=\"([^\"]+)\"",
  "g",
);

function recode(response, Stream) {
  return new Response(response.body.pipeThrough(new Stream("gzip")), response);
}

function store(cache, key, response) {
  return cache.put(key, recode(response, CompressionStream));
}

async function precache() {
  if (!registration.scope.endsWith(PLAYGROUND_PATH)) return;
  const cache = await caches.open(CACHE_NAME);
  const response = await fetch(PLAYGROUND_PATH, {cache: "no-cache"});
  if (!response.ok) {
    throw new Error(`Unable to load Playground: ${response.status}`);
  }
  const html = await response.clone().text();
  await store(cache, PLAYGROUND_PATH, response);
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
  await Promise.allSettled([...urls].map(async (url) => {
    const asset = await fetch(url);
    if (asset.ok) await store(cache, url, asset);
  }));
}

async function networkFirst(event) {
  const {request} = event;
  const cache = await caches.open(CACHE_NAME);
  const navigate = request.mode === "navigate";
  const key = navigate ? new URL(request.url).pathname : request;
  const cached = await cache.match(key);
  const network = fetch(request).then((response) => {
    const etag = response.headers.get("etag");
    if (response.ok && !(etag && cached?.headers.get("etag") === etag)) {
      event.waitUntil(store(cache, key, response.clone()));
    }
    return response;
  });
  if (!cached) return network;
  const timer = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT));
  const response = await Promise.race([network.catch(() => {}), timer]);
  return response || recode(cached, DecompressionStream);
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
