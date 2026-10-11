"use strict";

const ext = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const FIELDS = Object.keys(MOEKURA_DEFAULTS);
const BOORUS = ext.runtime.getManifest().host_permissions;

function say(output, text, tone = "") {
  output.textContent = text;
  output.className = tone;
}

// The site's address as typed, or null if it isn't one.
function instanceBase() {
  try {
    const url = new URL($("instanceUrl").value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

// Asks for access to the site (any port: Firefox's patterns can't name
// one). Must be called straight from a click: the browser only shows its
// prompt in answer to one.
function requestSite(base) {
  const { protocol, hostname } = new URL(base);
  return ext.permissions.request({ origins: [`${protocol}//${hostname}/*`] });
}

async function load() {
  const values = await ext.storage.local.get(MOEKURA_DEFAULTS);
  for (const key of FIELDS) {
    const input = $(key);
    if (input.type === "checkbox") input.checked = values[key];
    else input.value = values[key];
  }
  $("boorus").hidden = await ext.permissions.contains({ origins: BOORUS });
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = $("saveResult");
  const base = instanceBase();
  if (!base) {
    say(result, "Enter your site's address, starting with https://.", "bad");
    $("instanceUrl").focus();
    return;
  }
  const allowed = await requestSite(base);
  const values = {};
  for (const key of FIELDS) {
    const input = $(key);
    values[key] = input.type === "checkbox" ? input.checked : input.value.trim();
  }
  values.instanceUrl = base;
  await ext.storage.local.set(values);
  $("instanceUrl").value = base;
  if (allowed) say(result, "Saved.", "ok");
  else say(result, `Saved, but uploads need access to ${new URL(base).origin}: save again to allow it.`, "bad");
});

$("test").addEventListener("click", async () => {
  const result = $("testResult");
  const base = instanceBase();
  const key = $("apiKey").value.trim();
  if (!base || !key) {
    say(result, "Enter the site's address and an API key first.", "bad");
    return;
  }
  if (!(await requestSite(base))) {
    say(result, `The extension needs access to ${new URL(base).origin}.`, "bad");
    return;
  }
  $("test").disabled = true;
  say(result, "Checking…");
  try {
    const response = await fetch(`${base}/api/v1/me`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      credentials: "omit",
    });
    const body = await response.json().catch(() => null);
    if (response.status === 401) {
      say(result, "The site didn't accept this API key.", "bad");
    } else if (!response.ok || !body?.name) {
      say(result, body?.error?.message || `The site answered ${response.status}; is this a Moekura site?`, "bad");
    } else if (!body.permissions?.includes("upload")) {
      say(result, `Signed in as ${body.name}, who can't upload.`, "bad");
    } else if (body.upload_limits?.refused) {
      say(result, `Signed in as ${body.name}. ${body.upload_limits.refused}`, "bad");
    } else {
      say(result, `Signed in as ${body.name}. Ready to upload.`, "ok");
    }
  } catch (error) {
    say(result, `Couldn't reach the site: ${error.message}`, "bad");
  } finally {
    $("test").disabled = false;
  }
});

$("grantBoorus").addEventListener("click", async () => {
  if (await ext.permissions.request({ origins: BOORUS })) $("boorus").hidden = true;
});

load();
