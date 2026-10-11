// The "Clone to Moekura" button on a booru's post page. It reads the post
// (sites.js) and hands it to the background script, which downloads the
// file and uploads it; this page only shows how that goes.

"use strict";

(() => {
  const ext = globalThis.browser ?? globalThis.chrome;
  const read = globalThis.moekuraSites.detect();
  if (!read) return;

  let busy = false;
  let ui = null;

  ext.runtime.sendMessage({ type: "ready" }).catch(() => {});
  ext.runtime.onMessage.addListener((message) => {
    if (message?.type === "trigger") clone();
  });

  ext.storage.local.get({ showButton: true }).then(({ showButton }) => {
    if (showButton) show().idle();
  });

  async function clone(staged) {
    if (busy) return;
    busy = true;
    const view = show();
    view.working("Reading the post…");
    let post;
    try {
      post = await read();
    } catch (error) {
      busy = false;
      view.error(`Couldn't read this post: ${error.message}`, () => clone());
      return;
    }
    const port = ext.runtime.connect({ name: "clone" });
    let finished = false;
    port.onMessage.addListener((message) => {
      switch (message.state) {
        case "progress":
          view.working(message.text, message.fraction);
          return;
        case "done":
          view.done(`Posted #${message.id}`, message.url);
          break;
        case "duplicate":
          view.done(`Already there: #${message.id}`, message.url);
          break;
        case "similar":
          view.similar(message, () => clone(message.staged));
          break;
        case "setup":
          view.error(message.text, null, () => ext.runtime.sendMessage({ type: "options" }));
          break;
        default:
          view.error(message.text || "Something went wrong.", () => clone(staged));
      }
      finished = true;
      busy = false;
      port.disconnect();
    });
    port.onDisconnect.addListener(() => {
      if (finished) return;
      busy = false;
      view.error("The extension stopped before the upload finished.", () => clone(staged));
    });
    port.postMessage({ type: "clone", post, staged });
  }

  // The floating button, made on first use.
  function show() {
    if (ui) return ui;
    const host = document.createElement("moekura-uploader");
    host.style.cssText = "all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .box {
          display: flex; align-items: center; gap: 8px; max-width: min(420px, calc(100vw - 32px));
          padding: 6px 6px 6px 14px; border-radius: 999px;
          background: #1b2230; color: #e8edf6; border: 1px solid #2e3a50;
          box-shadow: 0 6px 20px rgb(0 0 0 / .35);
          font: 500 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
        }
        .box.idle { padding: 0; }
        .text { overflow-wrap: anywhere; }
        .text a { color: #8fb8ff; text-decoration: none; }
        .text a:hover { text-decoration: underline; }
        .ok .text::before { content: "✓ "; color: #7bd88f; }
        .bad { border-color: #6b3340; }
        .bad .text::before { content: "! "; color: #ff8a9a; font-weight: 700; }
        button {
          all: unset; cursor: pointer; white-space: nowrap; border-radius: 999px;
          padding: 6px 12px; background: #2f6fdb; color: #fff; font-weight: 600;
        }
        button:hover { background: #3d7ff0; }
        button:focus-visible { outline: 2px solid #8fb8ff; outline-offset: 2px; }
        button.quiet { background: transparent; color: #aab6c9; padding: 6px 8px; }
        button.quiet:hover { color: #fff; background: #2a3448; }
        .idle button { padding: 9px 16px; }
        .spinner {
          flex: none; width: 14px; height: 14px; border-radius: 50%;
          border: 2px solid #3a4a66; border-top-color: #8fb8ff;
          animation: spin .8s linear infinite;
        }
        .bar { flex: none; width: 60px; height: 4px; border-radius: 2px; background: #3a4a66; overflow: hidden; }
        .bar > i { display: block; height: 100%; background: #8fb8ff; }
        .working { padding-right: 14px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }
      </style>
      <div class="box" role="status" aria-live="polite"></div>`;
    const box = root.querySelector(".box");
    document.documentElement.append(host);

    const el = (tag, props = {}, ...children) => {
      const node = Object.assign(document.createElement(tag), props);
      node.append(...children);
      return node;
    };
    const button = (label, onclick, quiet = false) =>
      el("button", { type: "button", textContent: label, onclick, className: quiet ? "quiet" : "" });
    const close = () => Object.assign(button("✕", () => ui.idle(), true), { title: "Dismiss", ariaLabel: "Dismiss" });
    const render = (state, ...children) => {
      box.className = `box ${state}`;
      box.replaceChildren(...children);
    };
    const link = (label, href) => el("a", { href, target: "_blank", rel: "noopener", textContent: label });

    ui = {
      idle() {
        ext.storage.local.get({ showButton: true }).then(({ showButton }) => {
          if (!showButton) {
            host.remove();
            ui = null;
            return;
          }
          render("idle", button("Clone to Moekura", () => clone()));
        });
      },
      working(text, fraction) {
        const progress =
          typeof fraction === "number"
            ? el("span", { className: "bar" }, el("i", { style: `width: ${Math.round(fraction * 100)}%` }))
            : el("span", { className: "spinner" });
        render("working", progress, el("span", { className: "text", textContent: text }));
      },
      done(text, url) {
        render("ok", el("span", { className: "text" }, link(text, url)), close());
      },
      similar({ similar, base }, onUpload) {
        const posts = similar.slice(0, 5).flatMap((id, i) => [i ? ", " : "", link(`#${id}`, `${base}/posts/${id}`)]);
        render(
          "bad",
          el("span", { className: "text" }, "Looks like ", ...posts),
          button("Upload anyway", onUpload),
          close(),
        );
      },
      error(text, retry, settings) {
        render(
          "bad",
          el("span", { className: "text", textContent: text }),
          ...(retry ? [button("Retry", retry)] : []),
          ...(settings ? [button("Settings", settings)] : []),
          close(),
        );
      },
    };
    return ui;
  }
})();
