import {execSync} from "node:child_process";

const BASE = "http://127.0.0.1:8000";
const CDP = "http://127.0.0.1:9222";
const SCOPES = [`${BASE}/assets/playground/`, `${BASE}/play/`];
const ASSETS = [
  "/play/",
  "/assets/playground/playground.js",
  "/assets/playground/playground-worker.js",
  "/assets/playground/wasm_exec.js",
  "/assets/playground/runtime.wasm",
];
const RAN = "document.querySelector('[data-ys-playground]').dataset.state" +
  " === 'success'";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = false;

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

async function open(path) {
  await send("Page.navigate", {url: BASE + path});
  await sleep(500);
  return until(
    `document.readyState === "complete" &&
      location.href === ${JSON.stringify(BASE + path)}`,
    30,
  );
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
check("Help dialog shows the install line", await evaluate(
  `document.querySelector("[data-help-dialog]").textContent
    .includes("Add to Home Screen")`,
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

execSync("pkill -f '[m]kdocs serve' || true");
await sleep(2000);
check("server is stopped", await fetch(`${BASE}/play/`)
  .then(() => false, () => true));

await open("/play/");
check("offline: program runs", await until(RAN, 60));
await open("/play/?v=2&e=offline-test");
check("offline: program runs with a query string", await until(RAN, 60));

socket.close();
process.exit(failed ? 1 : 0);
