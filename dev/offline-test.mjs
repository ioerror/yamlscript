import {createHash} from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const SITE = process.argv[2];
const BASE = "http://127.0.0.1:8000";
const CDP = "http://127.0.0.1:9222";
const WASM = "/assets/playground/runtime.wasm";
const SCOPES = [`${BASE}/assets/playground/`, `${BASE}/play/`];
const ASSETS = [
  "/play/",
  "/assets/playground/playground.js",
  "/assets/playground/playground-worker.js",
  "/assets/playground/wasm_exec.js",
  WASM,
];
const TYPES = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};
const RAN = "document.querySelector('[data-ys-playground]').dataset.state" +
  " === 'success'";
const SOURCE = "document.querySelector('[data-panel=source] .cm-content')";
const OUTPUT = "document.querySelector('[data-output=evaluation]')";
const CACHED =
  `caches.open("ys-play-v1").then((cache) => cache.match("${WASM}"))`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hits = {};
let stalled = false;
let salt = "";
let serial = 0;
let failed = false;

const server = http.createServer((request, response) => {
  if (stalled) return;
  const {pathname} = new URL(request.url, BASE);
  const index = pathname.endsWith("/") ? "index.html" : "";
  const file = path.join(SITE, pathname, index);
  fs.readFile(file, (error, data) => {
    if (error) {
      response.writeHead(404).end();
      return;
    }
    const etag = `"${createHash("sha1").update(data).digest("hex")}${salt}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, {etag, "cache-control": "max-age=600"}).end();
      return;
    }
    hits[pathname] = (hits[pathname] || 0) + 1;
    response.writeHead(200, {
      "cache-control": "max-age=600",
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      etag,
      "x-serial": ++serial,
    });
    response.end(data);
  });
}).listen(8000, "127.0.0.1");

function check(name, pass) {
  if (!pass) failed = true;
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}`);
}

async function browserUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`${CDP}/json/version`);
      return (await response.json()).webSocketDebuggerUrl;
    } catch (error) {
      await sleep(500);
    }
  }
  throw new Error("Chromium did not start");
}

const socket = new WebSocket(await browserUrl());
await new Promise((resolve) => socket.addEventListener("open", resolve));
const pending = new Map();
let nextId = 0;
let sessionId;
socket.addEventListener("message", ({data}) => {
  const message = JSON.parse(data);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});

function send(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({id, method, params, sessionId}));
  return new Promise((resolve, reject) => {
    pending.set(id, ({result, error}) => {
      if (error) reject(new Error(`${method}: ${error.message}`));
      else resolve(result);
    });
  });
}

async function evaluate(expression) {
  const {result, exceptionDetails} = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text);
  return result.value;
}

async function until(expression, seconds = 120) {
  for (let i = 0; i < seconds * 2; i++) {
    const value = await evaluate(expression).catch(() => false);
    if (value) return value;
    await sleep(500);
  }
  return false;
}

async function open(url, ready = "document.readyState === 'complete'") {
  await evaluate("window.stale = true");
  await send("Page.navigate", {url: new URL(url, BASE).href});
  return until(`!window.stale && ${ready}`, 60);
}

async function type(text) {
  await evaluate(`${SOURCE}.focus()`);
  await send("Input.insertText", {text});
}

const {targetId} = await send("Target.createTarget", {url: "about:blank"});
({sessionId} = await send("Target.attachToTarget", {targetId, flatten: true}));
await send("Page.enable");

await open("/play/");
check("play page links the manifest", await evaluate(
  "document.querySelector('link[rel=manifest]')?.href",
) === `${BASE}/play.webmanifest`);
check("service worker is active for both scopes", await until(
  `navigator.serviceWorker.getRegistrations().then((all) =>
    navigator.serviceWorker.controller &&
    all.every((r) => r.active?.state === "activated") &&
    JSON.stringify(all.map((r) => r.scope).sort()) ===
      ${JSON.stringify(JSON.stringify(SCOPES))})`,
));
check("online: program runs", await until(RAN));
check("cache holds the play page and its assets", await until(
  `caches.open("ys-play-v1")
    .then((cache) => cache.keys())
    .then((keys) => keys.map((key) => new URL(key.url).pathname))
    .then((paths) => ${JSON.stringify(ASSETS)}
      .every((asset) => paths.includes(asset)))`,
  60,
));
check("first visit downloads runtime.wasm one time", hits[WASM] === 1);
const size = fs.statSync(path.join(SITE, WASM)).size;
const stored = await evaluate(
  `${CACHED}.then((r) => r.arrayBuffer()).then((b) => b.byteLength)`,
);
console.log(`runtime.wasm bytes: ${size}, bytes in the cache: ${stored}`);
check("cache holds runtime.wasm compressed", stored < size / 2);
check("Help dialog shows the install line", await evaluate(
  `document.querySelector("[data-help-dialog]").textContent
    .includes("Add to Home Screen")`,
));

const cachedSerial = `${CACHED}.then((r) => r.headers.get("x-serial"))`;
const first = await evaluate(cachedSerial);
await open("/play/", RAN);
await sleep(2000);
check(
  "same ETag: cache keeps its copy",
  await evaluate(cachedSerial) === first,
);
salt = "x";
await send("Network.clearBrowserCache");
await open("/play/", RAN);
check("new ETag: cache takes the new copy", await until(
  `${cachedSerial}.then((value) => value !== "${first}")`,
  30,
));
check("page shows the ready offline status", await until(
  `"offline" in document.documentElement.dataset &&
    getComputedStyle(document.querySelector("[data-status]"), "::after")
      .content.includes("ready offline")`,
  30,
));

await evaluate(`dispatchEvent(
  Object.assign(new Event("beforeinstallprompt"), {
    prompt() {
      window.prompted = true;
    },
  }),
);
document.querySelector("[data-install]").click()`);
check("install button opens the install prompt", await evaluate(
  "window.prompted && !document.querySelector('[data-install]').hidden",
));

await send("Emulation.setTouchEmulationEnabled", {enabled: true});
check("phone: editor has no autocorrect and no autocapitalize", await evaluate(
  `${SOURCE}.getAttribute("autocorrect") === "off" &&
    ${SOURCE}.getAttribute("autocapitalize") === "off"`,
));
check("phone: editor font is 16px and the key row shows", await evaluate(
  `matchMedia("(pointer: coarse)").matches &&
    getComputedStyle(document.querySelector(".cm-editor")).fontSize ===
      "16px" &&
    getComputedStyle(document.querySelector("[data-keys]")).display ===
      "flex"`,
));
check("stylesheet hides the docs header in an installed app", await evaluate(
  `[...[...document.styleSheets]
    .find((sheet) => sheet.href?.endsWith("/css/theme.css")).cssRules]
    .some((rule) => rule.media?.mediaText === "(display-mode: standalone)" &&
      rule.cssRules[0].selectorText.includes(".md-header") &&
      rule.cssRules[0].style.display === "none")`,
));
await send("Emulation.setTouchEmulationEnabled", {enabled: false});

await type("");
await evaluate(`for (const key of ["$", "indent"]) {
  [...document.querySelectorAll("[data-keys] button")]
    .find((button) => button.textContent === key)
    .dispatchEvent(new Event("pointerdown", {bubbles: true}));
}`);
check("key row inserts text and indents", await evaluate(
  `${SOURCE}.textContent.startsWith("  $")`,
));

await open("/play/", RAN);
await evaluate("document.querySelector('[data-category=program]').click()");
await sleep(1000);
await until(RAN);
await evaluate(`document.querySelector("[data-stdin]").value = "from stdin";
  ${SOURCE}.focus();
  document.execCommand("selectAll")`);
await type("!ys-0\nsay: read('/dev/stdin')\n");
check("program reads its input", await until(
  `${OUTPUT}.textContent.includes("from stdin")`,
));

await open("/play/", RAN);
await type("# shared\n");
await evaluate(`navigator.clipboard.writeText = async (text) => {
  window.shared = text;
};
window.prompt = () => "mine";
document.querySelector("[data-share]").click();
document.querySelector("[data-save]").click()`);
const shared = await until("window.shared", 10);
check("Share makes a link with the state in the hash", shared &&
  new URL(shared).hash.length > 1);
check("Save adds a saved program", await evaluate(
  `[...document.querySelector("[data-saved]").options]
    .some((option) => option.textContent === "mine")`,
));

const manifest = await send("Page.getAppManifest");
const app = JSON.parse(manifest.data || "{}");
check("saved program has its own manifest", !manifest.errors.length &&
  app.name === "mine" && app.start_url.includes("app=mine") &&
  new URL(app.start_url).hash.length > 1);
console.log("installability errors: " + JSON.stringify(
  (await send("Page.getInstallabilityErrors")).installabilityErrors,
));

await open("/about/");
check("docs page has no service worker", await evaluate(
  `navigator.serviceWorker.controller === null &&
    !document.querySelector("link[rel=manifest]") &&
    !document.head.innerHTML.includes("serviceWorker")`,
));

await open("/doc/install/");
check("install document links to /play/", await evaluate(
  `[...document.querySelectorAll("article a")]
    .some((a) => a.textContent === "Playground" &&
      new URL(a.href).pathname === "/play/")`,
));

const edited = `${RAN} && ${SOURCE}.textContent.includes("# shared")`;
stalled = true;
check("stalled network: shared link runs from the cache", await open(
  shared,
  edited,
));

server.closeAllConnections();
server.close();
await sleep(1000);
check("server is stopped", await fetch(`${BASE}/play/`)
  .then(() => false, () => true));
check("offline: program runs", await open("/play/", RAN));
await evaluate(`const saved = document.querySelector("[data-saved]");
  saved.selectedIndex = 1;
  saved.dispatchEvent(new Event("change"));`);
check("offline: saved program opens and runs as its own app", await until(
  `location.search.includes("t=") && document.title === "mine" && ${edited}`,
  60,
));

socket.close();
process.exit(failed ? 1 : 0);
