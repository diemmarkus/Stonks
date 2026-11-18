// stonks' service worker does one thing: receive files shared to the installed app (Android's
// share menu → "Stonks"), e.g. a flatex PDF confirmation. It keeps them in Cache Storage
// ("stonks-share") for the page to pick up and import; the page deletes them right after.
// It caches nothing else and every other request goes to the network as usual.
const SHARE_CACHE = "stonks-share";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.pathname.endsWith("/share")) e.respondWith(receive(e.request));
});

async function receive(request) {
  try {
    const data = await request.formData();
    const files = data.getAll("files").filter((f) => f && typeof f !== "string");
    await caches.delete(SHARE_CACHE);
    const cache = await caches.open(SHARE_CACHE);
    await Promise.all(files.map((f, i) => cache.put(new URL(`./shared/${i}`, self.registration.scope).href,
      new Response(f, { headers: { "content-type": f.type || "application/octet-stream", "x-name": encodeURIComponent(f.name || `shared-${i}`) } }))));
  } catch (e) { console.warn("Share failed", e); }
  return Response.redirect(new URL("./#/share", self.registration.scope).href, 303);
}
