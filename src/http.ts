import { requestUrl } from "obsidian";
import type { HttpClient } from "isomorphic-git";

type Body = AsyncIterableIterator<Uint8Array> | Uint8Array[] | undefined;

async function collect(body: Body): Promise<ArrayBuffer | undefined> {
  if (!body) return undefined;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

/**
 * git-over-HTTP through Obsidian's own network stack rather than fetch().
 *
 * This is not a convenience: a browser fetch to github.com from a plugin is
 * blocked by CORS, and GitHub serves no CORS headers on the smart-HTTP endpoints.
 * requestUrl is a native request on every platform, so it has no origin to be
 * refused for — which is what makes push and fetch work on iOS and Android.
 */
export const http: HttpClient = {
  async request(req) {
    const body = await collect(req.body as Body);
    const res = await requestUrl({
      url: req.url,
      method: req.method ?? "GET",
      headers: req.headers ?? {},
      body,
      throw: false,
    });

    const bytes = new Uint8Array(res.arrayBuffer);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = String(v);

    return {
      url: req.url,
      method: req.method ?? "GET",
      statusCode: res.status,
      statusMessage: String(res.status),
      headers,
      body: (async function* () {
        yield bytes;
      })(),
    };
  },
};
