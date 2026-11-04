import { randomUUID } from "node:crypto";

// Keep decrypted metadata in memory and avoid Chromium's data-URL size limit.
export function createLocalPages(protocol) {
  const pages = new Map();
  protocol.handle("dsh-sci-page", (request) => {
    const html = pages.get(request.url);
    if (html === undefined) return new Response("Page expired. Reopen the window.", { status: 404 });
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  });
  return {
    set(name, html) {
      if (!/^[a-z-]+$/.test(name)) throw new Error("Invalid local page name");
      const url = `dsh-sci-page://${name}/${randomUUID()}`;
      pages.set(url, html);
      const previous = [...pages.keys()].filter((key) => new URL(key).hostname === name);
      for (const key of previous.slice(0, -2)) pages.delete(key);
      return url;
    },
    clear(name) {
      for (const key of pages.keys()) if (new URL(key).hostname === name) pages.delete(key);
    },
  };
}
