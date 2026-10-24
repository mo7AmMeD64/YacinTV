/**
 * Yacine TV — Stremio addon for Cloudflare Workers (single file, no dependencies)
 *
 * Port of YacineTVProvider (CloudStream extension "Yacintv").
 * Flow, exactly like the original extension:
 *   1. Firebase Installations -> auth token
 *   2. Firebase Remote Config -> current API domain ("defaults" entry)
 *   3. API responses are Base64 + XOR encrypted (key = BASE_KEY + response header "t")
 *
 * Stremio routes handled:
 *   /                           install page
 *   /manifest.json              (one catalog per Yacine category, built live)
 *   /catalog/tv/{id}[/{extra}].json
 *   /meta/tv/{id}.json
 *   /stream/tv/{id}.json
 *   /debug                      shows what each upstream step returned (safe to delete)
 *
 * ID scheme:  yacin:{base64url(JSON [channelId, name, logo])}
 *   -> meta needs no upstream call, streams only need the channel id.
 */

const PREFIX = "yacin:";
const DEFAULT_URL = "https://def11.ycnapi.com/api";
const FALLBACK_URL = "https://deft.yacinelive.com/api";
const BASE_KEY = "c!xZj+N9&G@Ev@vw";
const ICON =
  "https://yt3.googleusercontent.com/ulm35tweg3do5istps0TgCjMmJSVczGUL2NIrXMwI1DDRi5ty29BIzQSUHVgqZN5CSo1PHhiA6M=s900-c-k-c0x00ffffff-no-rj";

const FB_PROJECT_ID = "ycntv-7a08e";
const FB_PROJECT_NUMBER = "692330584196";
const FB_APP_ID = "1:692330584196:android:68ea9f0c920aa17904cad1";
const FB_API_KEY = "AIzaSyDRKL14PPiXzk7qNUNLgV2IsjasxNpWLeU";
const FB_PKG = "ver3.ycntivi.off";
const FB_CERT = "E404353443FB03A54702D53E2C7563D791D92559";
const FB_CLIENT = "H4sIAAAAAAAA_6tWykhNLCpJSk0sKVayio7VUSpLLSrOzM9TslIyUqoFAFyivEQfAAAA";
const DALVIK_UA = "Dalvik/2.1.0 (Linux; U; Android 16; RMX5061 Build/BP2A.250605.015)";
const API_UA = "okhttp/4.12.0";

const SYNC_TTL = 30 * 60 * 1000; // re-check the API domain every 30 min
const LIST_TTL = 5 * 60 * 1000; // categories / channel lists cache
const MAX_LISTS = 40; // free plan allows 50 subrequests per request

// Kept in the isolate between requests (same idea as @Volatile in the Kotlin code).
const st = { url: DEFAULT_URL, etag: null, fid: null, token: null, nextSync: 0 };
const memo = new Map();
const trace = [];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function note(step, info) {
  trace.push({ step, ...info });
  if (trace.length > 40) trace.shift();
}

function errText(e) {
  return String((e && e.message) || e);
}

// ------------------------------------------------------------------ helpers
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeId(chan) {
  return PREFIX + b64urlEncode(JSON.stringify([String(chan.id), chan.name || "Unknown", chan.logo || ""]));
}

function decodeId(id) {
  if (!id || !id.startsWith(PREFIX)) return null;
  try {
    const [cid, name, logo] = JSON.parse(b64urlDecode(id.slice(PREFIX.length)));
    return { cid, name, logo };
  } catch (e) {
    return null;
  }
}

// Same as the Kotlin generateFid(): 17 random bytes, first byte forced to 0111xxxx, 22 chars.
function generateFid() {
  const b = new Uint8Array(17);
  crypto.getRandomValues(b);
  b[0] = (b[0] & 0x0f) | 0x70;
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 22);
}

// Same as the Kotlin decrypt(): Base64 -> XOR with (BASE_KEY + t) repeated.
function decrypt(text, t) {
  const key = new TextEncoder().encode(BASE_KEY + t);
  const bin = atob(text.trim().replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) ^ key[i % key.length];
  return new TextDecoder().decode(out);
}

// ------------------------------------------------------------------ Firebase
async function getFirebaseToken(fid) {
  const url = `https://firebaseinstallations.googleapis.com/v1/projects/${FB_PROJECT_ID}/installations`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Android-Package": FB_PKG,
        "X-Android-Cert": FB_CERT,
        "x-goog-api-key": FB_API_KEY,
        "x-firebase-client": FB_CLIENT,
        "User-Agent": DALVIK_UA,
      },
      body: JSON.stringify({ fid, appId: FB_APP_ID, authVersion: "FIS_v2", sdkVersion: "a:18.0.0" }),
      signal: AbortSignal.timeout(15000),
    });
    note("firebase-installations", { status: res.status });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && data.authToken && data.authToken.token) || null;
  } catch (e) {
    note("firebase-installations", { error: errText(e) });
    return null;
  }
}

async function doSync() {
  let ok = false;
  try {
    if (!st.fid || !st.token) {
      const fid = generateFid();
      const token = await getFirebaseToken(fid);
      if (token) {
        st.fid = fid;
        st.token = token;
      }
    }
    if (st.fid && st.token) {
      const headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": FB_API_KEY,
        "X-Android-Package": FB_PKG,
        "X-Android-Cert": FB_CERT,
        "X-Goog-Firebase-Installations-Auth": st.token,
        "X-Firebase-RC-Fetch-Type": "BASE/1",
        "User-Agent": DALVIK_UA,
      };
      if (st.etag) headers["If-None-Match"] = st.etag;

      const res = await fetch(
        `https://firebaseremoteconfig.googleapis.com/v1/projects/${FB_PROJECT_NUMBER}/namespaces/firebase:fetch`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            appVersion: "3.1",
            firstOpenTime: new Date().toISOString(),
            timeZone: "Asia/Baghdad",
            appInstanceIdToken: st.token,
            languageCode: "ar-IQ",
            appBuild: "4",
            appInstanceId: st.fid,
            countryCode: "IQ",
            analyticsUserProperties: {},
            appId: FB_APP_ID,
            platformVersion: "36",
            sdkVersion: "22.0.0",
            packageName: FB_PKG,
          }),
          signal: AbortSignal.timeout(15000),
        }
      );
      note("firebase-remote-config", { status: res.status });

      if (res.status === 304) {
        ok = true;
      } else if (res.ok) {
        const cfg = await res.json();
        note("firebase-remote-config", { state: cfg && cfg.state });
        if (cfg && cfg.state === "UPDATE") {
          const d = cfg.entries && cfg.entries.defaults;
          if (d) st.url = `https://${d}/api`;
          st.etag = res.headers.get("ETag") || null;
        }
        ok = true;
      } else if (res.status === 401 || res.status === 403) {
        st.fid = null; // token no longer valid, make a new one next time
        st.token = null;
        st.etag = null;
      }
    }
  } catch (e) {
    note("sync", { error: errText(e) });
  }
  st.nextSync = Date.now() + (ok ? SYNC_TTL : 60 * 1000);
  return st.url;
}

async function syncDynamicApiUrl() {
  if (Date.now() < st.nextSync) return st.url;
  return doSync();
}

// ------------------------------------------------------------------ API
async function fetchYacine(path, ttl = 0) {
  const hit = memo.get(path);
  if (hit && hit.exp > Date.now()) return hit.val;

  const dynamicUrl = await syncDynamicApiUrl();
  const bases = dynamicUrl === FALLBACK_URL ? [dynamicUrl] : [dynamicUrl, FALLBACK_URL];

  for (const base of bases) {
    const url = `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": API_UA, Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        note("api " + path, { base, status: res.status });
        continue;
      }
      const body = await res.text();
      if (!body) {
        note("api " + path, { base, status: res.status, empty: true });
        continue;
      }
      const plain = decrypt(body, res.headers.get("t") || "");
      const val = JSON.parse(plain);
      if (ttl > 0) memo.set(path, { exp: Date.now() + ttl, val });
      return val;
    } catch (e) {
      note("api " + path, { base, error: errText(e) });
    }
  }
  return null;
}

async function getCategories() {
  const r = await fetchYacine("categories", LIST_TTL);
  return r && Array.isArray(r.data) ? r.data.filter((c) => c && c.id != null) : [];
}

async function getChannels(catId) {
  const r = await fetchYacine(`categories/${encodeURIComponent(catId)}/channels`, LIST_TTL);
  return r && Array.isArray(r.data) ? r.data.filter((c) => c && c.id != null) : [];
}

async function getAllChannels() {
  const cats = (await getCategories()).slice(0, MAX_LISTS);
  const lists = await Promise.all(cats.map((c) => getChannels(c.id)));
  const seen = new Set();
  const all = [];
  for (const list of lists) {
    for (const ch of list) {
      const key = String(ch.id);
      if (!seen.has(key)) {
        seen.add(key);
        all.push(ch);
      }
    }
  }
  return all;
}

// ------------------------------------------------------------------ Stremio
function toMeta(chan) {
  const name = chan.name || "Unknown";
  const meta = {
    id: encodeId(chan),
    type: "tv",
    name,
    posterShape: "square",
    description: `شاهد بث مباشر لقناة ${name}`,
  };
  if (chan.logo) {
    meta.poster = chan.logo;
    meta.logo = chan.logo;
  }
  return meta;
}

async function buildManifest() {
  const cats = await getCategories();
  const catalogs = cats.map((c) => ({ type: "tv", id: "c" + c.id, name: c.name || "Category" }));
  if (!catalogs.length) catalogs.push({ type: "tv", id: "all", name: "Yacine TV - كل القنوات" });
  catalogs.push({
    type: "tv",
    id: "search",
    name: "Yacine TV",
    extra: [{ name: "search", isRequired: true }],
  });
  return {
    id: "community.yacintv",
    version: "1.0.0",
    name: "Yacine TV",
    description: "Yacine TV - قنوات البث المباشر",
    logo: ICON,
    resources: ["catalog", "meta", "stream"],
    types: ["tv"],
    idPrefixes: [PREFIX],
    catalogs,
    behaviorHints: { configurable: false },
  };
}

function parseExtra(str) {
  const out = {};
  if (!str) return out;
  for (const part of str.split("&")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try {
      out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1).replace(/\+/g, " "));
    } catch (e) {
      /* ignore malformed pair */
    }
  }
  return out;
}

async function handleCatalog(id, extraStr) {
  let channels = [];
  if (id === "search") {
    const q = (parseExtra(extraStr).search || "").trim().toLowerCase();
    if (q) channels = (await getAllChannels()).filter((c) => (c.name || "").toLowerCase().includes(q));
  } else if (id === "all") {
    channels = await getAllChannels();
  } else if (id.startsWith("c")) {
    channels = await getChannels(id.slice(1));
  }
  const metas = channels.map(toMeta);
  // An empty result is never cached, so a temporary failure doesn't stick.
  return json({ metas, cacheMaxAge: metas.length ? 300 : 0 });
}

function handleMeta(id) {
  const d = decodeId(id);
  if (!d) return json({ meta: null });
  return json({ meta: toMeta({ id: d.cid, name: d.name, logo: d.logo }) });
}

async function handleStream(id) {
  const d = decodeId(id);
  if (!d) return json({ streams: [] });
  const r = await fetchYacine(`channel/${encodeURIComponent(d.cid)}`);
  const list = r && Array.isArray(r.data) ? r.data : [];
  const streams = [];
  list.forEach((s, i) => {
    const url = String(s.url || "").replace("www.elahmad.coo", "www.elahmad.com");
    if (!/^https?:\/\//i.test(url)) return;
    const headers = {};
    if (s.headers && typeof s.headers === "object") {
      for (const [k, v] of Object.entries(s.headers)) if (typeof v === "string") headers[k] = v;
    }
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "user-agent")) headers["User-Agent"] = API_UA;
    streams.push({
      name: "Yacine TV",
      title: s.name || `Server ${i + 1}`,
      url,
      behaviorHints: { notWebReady: true, proxyHeaders: { request: headers } },
    });
  });
  return json({ streams });
}

// ------------------------------------------------------------------ pages
function landing(origin) {
  const host = origin.replace(/^https?:\/\//, "");
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Yacine TV</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;line-height:1.8}
a.b{display:block;padding:14px;margin:12px 0;border-radius:10px;background:#7b5bf5;color:#fff;text-align:center;text-decoration:none}
code{direction:ltr;display:block;word-break:break-all;background:#eee;padding:8px;border-radius:6px}</style></head><body>
<h2>Yacine TV — إضافة Stremio</h2>
<a class="b" href="stremio://${host}/manifest.json">تثبيت في Stremio</a>
<p>أو انسخ الرابط وأضفه يدوياً:</p>
<code>${origin}/manifest.json</code>
</body></html>`;
  return new Response(html, { headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } });
}

async function debug() {
  trace.length = 0;
  st.nextSync = 0;
  st.fid = null;
  st.token = null;
  st.etag = null;
  memo.clear();
  const apiUrl = await doSync();
  const cats = await getCategories();
  let sample = null;
  if (cats.length) {
    const chans = await getChannels(cats[0].id);
    sample = { category: cats[0].name, channels: chans.length, first: chans[0] ? chans[0].name : null };
  }
  return json({ apiUrl, categories: cats.length, sample, trace });
}

// ------------------------------------------------------------------ router
export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/") return landing(url.origin);
      if (path === "/manifest.json") return json(await buildManifest());
      if (path === "/debug") return await debug();

      if (path.endsWith(".json")) {
        const parts = path.slice(1, -5).split("/");
        const [resource, type, rawId, rawExtra] = parts;
        if (type !== "tv" || !rawId) return json({ err: "not found" }, 404);
        const id = decodeURIComponent(rawId);
        if (resource === "catalog") return await handleCatalog(id, rawExtra);
        if (resource === "meta") return handleMeta(id);
        if (resource === "stream") return await handleStream(id);
      }
      return json({ err: "not found" }, 404);
    } catch (e) {
      return json({ err: errText(e) }, 500);
    }
  },
};
