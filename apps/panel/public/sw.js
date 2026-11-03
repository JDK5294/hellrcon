/*
 * The panel's service worker. It does one job: phone notifications (Settings → Phone
 * notifications). It shows one when the panel's server sends it, and opens the panel where it
 * points when it is tapped. It never answers a page request, so the panel loads exactly as it does
 * without it.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** What the panel's server sent: its JSON, or — sent by anything else — the words as they came. */
function read(data) {
  try {
    return data ? data.json() : {};
  } catch {
    return { body: data ? data.text() : "" };
  }
}

self.addEventListener("push", (event) => {
  const note = read(event.data);
  // Every push shows something: a browser stops delivering to a site whose pushes stay silent.
  event.waitUntil(self.registration.showNotification(note.title || "Panel", {
    body: note.body || "",
    tag: note.tag || undefined,
    icon: "/icons/icon-192.png",
    data: { url: note.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // The panel, never the public demo (/demo) on the same address: it is not the panel, and what a
    // notification points at is none of its business.
    const panel = open.find((c) => {
      const at = new URL(c.url);
      return at.origin === self.location.origin && !/^\/demo(?:\/|$)/i.test(at.pathname);
    });
    if (!panel) return self.clients.openWindow(url);
    // An open panel goes there itself (lib/push listens), so it stays signed in and where it was.
    panel.postMessage({ type: "open", url });
    return panel.focus();
  })());
});
