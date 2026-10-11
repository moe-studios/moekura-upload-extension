// Uploads a post a booru page read for us (content/sites.js) to the
// Moekura site in the settings: downloads the original file with the
// browser's own login on the booru, then sends it with the post's tags,
// rating and source to `POST /api/v1/posts`.

"use strict";

const ext = globalThis.browser ?? globalThis.chrome;

// Chrome runs this as a service worker; Firefox loads settings.js first.
if (typeof MOEKURA_DEFAULTS === "undefined") importScripts("settings.js");

const settings = () => ext.storage.local.get(MOEKURA_DEFAULTS);

// Words Moekura reads as metatags or category prefixes before a `:`;
// tags starting with them are refused (moekura_core::tags).
const RESERVED_PREFIXES = new Set([
  "ai", "approver", "arttags", "chartags", "child", "comment", "commentary",
  "commentcount", "commenter", "copytags", "date", "downvote", "embedded",
  "exif", "duration", "fav", "favgroup", "favcount", "filesize", "filetype",
  "flagger", "gentags", "has", "height", "id", "is", "limit", "md5",
  "metatags", "mpixels", "newpool", "note", "notecount", "noter", "order",
  "ordfav", "ordfavgroup", "ordpool", "parent", "pixiv", "pixiv_id", "pool",
  "rating", "ratio", "score", "similar", "search", "source", "status",
  "tagcount", "upvote", "user", "width",
  "artist", "character", "copyright", "general", "meta",
]);
const TAG_MAX_LEN = 170;
const POST_MAX_TAGS = 1000;
const SOURCE_MAX_LEN = 2048;

// As moekura_core::tags::normalize: lower case, runs of whitespace and
// underscores to one `_`, none at the ends.
function normalize(raw) {
  return raw
    .toLowerCase()
    .replace(/[\s_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// The name, or null when Moekura would refuse it (and with it the upload).
function validTag(raw) {
  const name = normalize(raw);
  if (!name || [...name].length > TAG_MAX_LEN) return null;
  if (/^[-~]/.test(name) || name.includes("*") || /\p{Cc}/u.test(name)) return null;
  const colon = name.indexOf(":");
  if (colon > 0 && RESERVED_PREFIXES.has(name.slice(0, colon))) return null;
  return name;
}

// The upload's tag field: `category:name` for every category but general,
// which only sets the category of tags new to the site.
function tagField(tags, extra) {
  const seen = new Set();
  const out = [];
  for (const { name: raw, category } of tags) {
    const name = validTag(raw);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(category && category !== "general" ? `${category}:${name}` : name);
  }
  for (const word of extra.split(/\s+/).filter(Boolean)) {
    const name = word.includes(":") ? word.toLowerCase() : validTag(word);
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out.slice(0, POST_MAX_TAGS).join(" ");
}

function baseUrl(instanceUrl) {
  try {
    const url = new URL(instanceUrl.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

// Fetching -----------------------------------------------------------------

// Runs `work` while the extension's own requests to `url`'s host carry
// `referer`: boorus' file servers (Gelbooru's) send anything else a
// "hotlinking" page instead of the file, and fetch() can't set it itself.
async function withReferer(url, referer, work) {
  const id = Math.floor(Math.random() * 1e9) + 1;
  await ext.declarativeNetRequest.updateSessionRules({
    addRules: [
      {
        id,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "Referer", operation: "set", value: referer }],
        },
        condition: {
          requestDomains: [new URL(url).hostname],
          tabIds: [ext.tabs.TAB_ID_NONE],
          resourceTypes: ["xmlhttprequest", "other"],
        },
      },
    ],
  });
  try {
    return await work();
  } finally {
    await ext.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
  }
}

async function download(url, report) {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  const host = new URL(url).host;
  if (!response.ok) throw new Error(`${host} answered ${response.status}`);
  const type = response.headers.get("content-type") || "";
  if (/^(text\/|application\/(json|xhtml))/.test(type)) {
    throw new Error(`${host} sent a page instead of the file`);
  }
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body || !total) return response.blob();
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let shown = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const percent = Math.floor((received / total) * 100);
    if (percent !== shown) {
      shown = percent;
      report(`Downloading… ${percent}%`, received / total);
    }
  }
  return new Blob(chunks, { type });
}

function fileName(post, blob) {
  const last = decodeURIComponent(new URL(post.fileUrl).pathname.split("/").pop() || "");
  const extension = /\.(\w{2,5})$/.exec(last)?.[1] || blob.type.split("/")[1] || "bin";
  const id = /(\d+)\D*$/.exec(post.pageUrl)?.[1] || "post";
  return `${post.site.toLowerCase().replace(/\W+/g, "-")}-${id}.${extension}`;
}

// What Moekura answered, as a message for the page.
async function answer(response, base) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Not JSON: a proxy, or the CSRF check (plain text).
  }
  const error = body?.error;
  const postUrl = (id) => `${base}/posts/${id}`;
  if (response.status === 201 && body?.id) {
    return { state: "done", id: body.id, url: postUrl(body.id) };
  }
  if (response.status === 409 && error?.post_id) {
    return { state: "duplicate", id: error.post_id, url: postUrl(error.post_id) };
  }
  if (response.status === 409 && error?.staged) {
    return { state: "similar", similar: error.similar || [], staged: error.staged, base };
  }
  if (response.status === 401) {
    return { state: "setup", text: "Moekura didn't accept the API key. Check it in the settings." };
  }
  if (response.status === 403 && !error) {
    return {
      state: "error",
      text:
        "Moekura refused the request as cross-site. Add this extension's origin to " +
        "[server.cors] allowed_origins (see the extension's README).",
    };
  }
  if (response.status === 429) {
    const wait = response.headers.get("retry-after");
    return { state: "error", text: `Too many uploads${wait ? `; try again in ${wait} s` : ""}.` };
  }
  return {
    state: "error",
    text: error?.message || `Moekura answered ${response.status} ${response.statusText}`.trim(),
  };
}

// Cloning ------------------------------------------------------------------

async function clone(post, staged, report) {
  const config = await settings();
  const base = baseUrl(config.instanceUrl);
  if (!base || !config.apiKey.trim()) {
    return { state: "setup", text: "Set your Moekura site and API key first." };
  }
  const origin = new URL(base).origin;
  const { protocol, hostname } = new URL(base);
  // Without a port: Firefox's patterns can't name one.
  if (!(await ext.permissions.contains({ origins: [`${protocol}//${hostname}/*`] }))) {
    return { state: "setup", text: `The extension isn't allowed to reach ${origin} yet.` };
  }

  const form = new FormData();
  form.set("rating", post.rating || config.defaultRating);
  form.set("tags", tagField(post.tags, config.extraTags));
  const source = config.sourceMode === "page" ? post.pageUrl : post.source || post.pageUrl;
  form.set("source", [...source].slice(0, SOURCE_MAX_LEN).join(""));
  if (config.allowSimilar) form.set("allow_similar", "true");

  let downloadError = null;
  if (staged) {
    form.set("staged", String(staged));
  } else {
    let blob = null;
    if (post.fileUrl) {
      report("Downloading…");
      try {
        blob = await withReferer(post.fileUrl, post.pageUrl, () => download(post.fileUrl, report));
      } catch (error) {
        // Moekura may still get it: it knows these sites.
        console.warn("Downloading in the browser failed; Moekura will fetch it.", error);
        downloadError = error.message;
      }
    }
    if (blob) {
      form.set("file", blob, fileName(post, blob));
    } else {
      // The file, or the post's page, which Moekura reads for the original.
      form.set("url", post.fileUrl || post.pageUrl);
      form.set("ref", post.pageUrl);
    }
  }

  report("Uploading to Moekura…");
  let response;
  try {
    response = await fetch(`${base}/api/v1/posts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey.trim()}`, Accept: "application/json" },
      body: form,
      credentials: "omit",
    });
  } catch (error) {
    return { state: "error", text: `Couldn't reach ${origin}: ${error.message}` };
  }
  const result = await answer(response, base);
  if (result.state === "error" && downloadError) {
    result.text = `The browser couldn't download the file (${downloadError}), nor could Moekura: ${result.text}`;
  }
  return result;
}

// Service workers stop after 30 s without extension events, even with a
// fetch in flight; calling an API every so often keeps a long upload alive.
async function keepingAlive(work) {
  const timer = setInterval(() => ext.runtime.getPlatformInfo(), 20_000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

ext.runtime.onConnect.addListener((port) => {
  if (port.name !== "clone") return;
  let open = true;
  port.onDisconnect.addListener(() => (open = false));
  const send = (message) => open && port.postMessage(message);
  port.onMessage.addListener(async (message) => {
    if (message?.type !== "clone") return;
    const report = (text, fraction) => send({ state: "progress", text, fraction });
    let result;
    try {
      result = await keepingAlive(() => clone(message.post, message.staged, report));
    } catch (error) {
      console.error(error);
      result = { state: "error", text: error.message || String(error) };
    }
    send(result);
  });
});

// The toolbar button and its shortcut work on post pages only: their
// content script says when it's on one.
ext.runtime.onInstalled.addListener(async ({ reason }) => {
  await ext.action.disable();
  if (reason === "install") ext.runtime.openOptionsPage();
});
ext.runtime.onStartup?.addListener(() => ext.action.disable());

ext.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "ready" && sender.tab?.id != null) {
    ext.action.enable(sender.tab.id);
  } else if (message?.type === "options") {
    ext.runtime.openOptionsPage();
  }
});

ext.action.onClicked.addListener(async (tab) => {
  const { instanceUrl, apiKey } = await settings();
  if (!baseUrl(instanceUrl) || !apiKey.trim()) {
    ext.runtime.openOptionsPage();
    return;
  }
  ext.tabs.sendMessage(tab.id, { type: "trigger" }).catch(() => {});
});
