// Reading a post off the booru page it's shown on: which site and post
// this is, and the post's original file, tags, rating and source.
//
// Each site's reader returns
//   { site, pageUrl, fileUrl, rating, source, tags: [{ name, category }] }
// where `rating` is Moekura's `g`, `s`, `q` or `e` (or null when the site
// doesn't rate posts), `fileUrl` is null when the page doesn't show the
// original, and `category` is one of Moekura's built-in categories.

"use strict";

(() => {
  // Firefox's content scripts fetch as the extension unless they use the
  // page's own fetch; that one sends the page's cookies like the site does.
  const pageFetch =
    typeof content !== "undefined" && content.fetch
      ? content.fetch.bind(content)
      : fetch.bind(globalThis);

  async function getJson(path) {
    const url = new URL(path, location.origin);
    const response = await pageFetch(url.href, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`${url.host} answered ${response.status} for the post's data.`);
    }
    return response.json();
  }

  const absolute = (href) => (href ? new URL(href, location.href).href : null);
  const words = (text) => (text || "").split(/\s+/).filter(Boolean);
  const tagsOf = (names, category) => names.map((name) => ({ name, category }));

  // Everywhere but Danbooru, `s` and "safe" mean general.
  function rating(value) {
    switch ((value || "").trim().toLowerCase()) {
      case "g":
      case "general":
      case "s":
      case "safe":
        return "g";
      case "sensitive":
        return "s";
      case "q":
      case "questionable":
      case "mature":
        return "q";
      case "e":
      case "explicit":
      case "adult":
        return "e";
      default:
        return null;
    }
  }

  // The text after `label:` in the first list item that starts with it,
  // with the item's link when it has one ("Source: <a href=…>").
  function sidebarField(label) {
    const prefix = `${label.toLowerCase()}:`;
    for (const li of document.querySelectorAll("li")) {
      const text = li.textContent.trim();
      if (!text.toLowerCase().startsWith(prefix)) continue;
      const link = li.querySelector("a[href]");
      return { text: text.slice(prefix.length).trim(), href: link ? absolute(link.getAttribute("href")) : null };
    }
    return null;
  }

  function linkWithText(pattern) {
    return [...document.querySelectorAll("a[href]")].find((a) => pattern.test(a.textContent.trim()));
  }

  const metaContent = (selector) => document.querySelector(selector)?.getAttribute("content") || null;

  // Danbooru and e621 ---------------------------------------------------

  // Danbooru's tag categories, by number.
  const DANBOORU_CATEGORIES = { 0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta" };

  async function danbooru(id) {
    let post;
    try {
      post = await getJson(`/posts/${id}.json`);
    } catch (error) {
      // The page itself has it all too.
      const fromPage = danbooruPage(id);
      if (fromPage) return fromPage;
      throw error;
    }
    return {
      site: "Danbooru",
      pageUrl: `${location.origin}/posts/${id}`,
      fileUrl: post.file_url || null,
      // Danbooru's `s` is sensitive, as on Moekura.
      rating: ["g", "s", "q", "e"].includes(post.rating) ? post.rating : null,
      source: post.source || "",
      tags: [
        ...tagsOf(words(post.tag_string_artist), "artist"),
        ...tagsOf(words(post.tag_string_copyright), "copyright"),
        ...tagsOf(words(post.tag_string_character), "character"),
        ...tagsOf(words(post.tag_string_meta), "meta"),
        ...tagsOf(words(post.tag_string_general), "general"),
      ],
    };
  }

  function danbooruPage(id) {
    const image = document.querySelector(`section.image-container[data-id="${id}"]`);
    if (!image) return null;
    const tags = [...document.querySelectorAll(".categorized-tag-list li[data-tag-name]")].map((li) => ({
      name: li.dataset.tagName,
      category: DANBOORU_CATEGORIES[/tag-type-(\d+)/.exec(li.className)?.[1]] || "general",
    }));
    return {
      site: "Danbooru",
      pageUrl: `${location.origin}/posts/${id}`,
      fileUrl: absolute(image.dataset.fileUrl),
      rating: ["g", "s", "q", "e"].includes(image.dataset.rating) ? image.dataset.rating : null,
      source: image.dataset.source || "",
      tags: tags.length ? tags : tagsOf(words(image.dataset.tags), "general"),
    };
  }

  async function e621(id) {
    const { post } = await getJson(`/posts/${id}.json`);
    const group = (name) => post.tags?.[name] || [];
    return {
      site: location.hostname.includes("e926") ? "e926" : "e621",
      pageUrl: `${location.origin}/posts/${id}`,
      // Missing for posts e621 hides from visitors and for blacklisted ones.
      fileUrl: post.file?.url || null,
      rating: rating(post.rating),
      source: post.sources?.[0] || "",
      // As Moekura's own importer files them.
      tags: [
        ...tagsOf(group("artist"), "artist"),
        ...tagsOf(group("copyright"), "copyright"),
        ...tagsOf(group("character"), "character"),
        ...tagsOf([...group("meta"), ...group("lore")], "meta"),
        ...tagsOf([...group("general"), ...group("species")], "general"),
      ],
    };
  }

  // The Gelbooru family: Gelbooru, Safebooru, TBIB, Rule34.xxx ----------

  const GELBOORU_CATEGORIES = {
    artist: "artist",
    copyright: "copyright",
    character: "character",
    metadata: "meta",
    meta: "meta",
  };

  // Sidebar items are `<li class="tag-type-artist">` with a search link
  // whose `tags` parameter is the tag.
  function sidebarTags(categories, param) {
    const tags = [];
    for (const li of document.querySelectorAll('li[class*="tag-type-"]')) {
      const type = /tag-type-([\w-]+)/.exec(li.className)?.[1];
      const name = [...li.querySelectorAll("a[href]")]
        .map((a) => new URL(a.getAttribute("href"), location.href).searchParams.get(param))
        .find(Boolean);
      if (name) tags.push({ name, category: categories[type] || "general" });
    }
    return tags;
  }

  function gelbooruFile() {
    const original = linkWithText(/^original( image)?$/i);
    if (original) return absolute(original.getAttribute("href"));
    // TBIB's "Original image" link is drawn by script; it still has the href.
    const image = [...document.querySelectorAll('a[href*="/images/"]')].find(
      (a) => !a.closest("#post-list, .thumbnail-preview, .thumb"),
    );
    if (image) return absolute(image.getAttribute("href"));
    const video = document.querySelector("video source[src], video[src]");
    if (video) return absolute(video.getAttribute("src"));
    return absolute(metaContent('meta[property="og:image"]'));
  }

  async function gelbooru(id, site) {
    let tags = sidebarTags(GELBOORU_CATEGORIES, "tags");
    if (tags.length === 0) {
      tags = tagsOf(words(document.querySelector("textarea#tags")?.value), "general");
    }
    const sourceField = document.querySelector('input#source, input[name="source"]')?.value?.trim();
    const sourceLine = sidebarField("Source");
    return {
      site,
      pageUrl: `${location.origin}/index.php?page=post&s=view&id=${id}`,
      fileUrl: gelbooruFile(),
      // The sidebar's word, not the edit form's letter: `s` is "Sensitive"
      // on Gelbooru but "Safe" on Safebooru.
      rating: rating(sidebarField("Rating")?.text) || rating(metaContent('meta[name="rating"]')),
      source: sourceField || sourceLine?.href || sourceLine?.text || "",
      tags,
    };
  }

  // Moebooru: yande.re, Konachan -----------------------------------------

  const MOEBOORU_CATEGORIES = {
    artist: "artist",
    // Danbooru files circles as artists.
    circle: "artist",
    copyright: "copyright",
    character: "character",
    faults: "meta",
  };

  // Moebooru pages hand the post to their own scripts as
  // `Post.register_resp({posts: […], tags: {name: type}})`.
  function registeredPost(id) {
    for (const script of document.querySelectorAll("script:not([src])")) {
      const text = script.textContent;
      const start = text.indexOf("Post.register_resp(");
      if (start < 0) continue;
      const open = text.indexOf("{", start);
      const close = text.lastIndexOf("})");
      if (open < 0 || close < open) continue;
      try {
        const data = JSON.parse(text.slice(open, close + 1));
        const post = data.posts?.find((p) => String(p.id) === id);
        if (post) return { post, types: data.tags || {} };
      } catch {
        // Not the shape we know; ask the API instead.
      }
    }
    return null;
  }

  async function moebooru(id, site) {
    let found = registeredPost(id);
    if (!found) {
      const posts = await getJson(`/post.json?tags=id:${id}`);
      if (!posts[0]) throw new Error(`${site} has no post #${id}.`);
      found = { post: posts[0], types: {} };
    }
    const { post, types } = found;
    let tags = words(post.tags).map((name) => ({
      name,
      category: MOEBOORU_CATEGORIES[types[name]] || "general",
    }));
    // Without the page's own list, the sidebar has the categories.
    if (Object.keys(types).length === 0) {
      const sidebar = new Map(sidebarTags(MOEBOORU_CATEGORIES, "tags").map((t) => [t.name, t.category]));
      tags = tags.map((t) => ({ name: t.name, category: sidebar.get(t.name) || "general" }));
    }
    return {
      site,
      pageUrl: `${location.origin}/post/show/${id}`,
      fileUrl: post.file_url ? absolute(post.file_url) : null,
      rating: rating(post.rating),
      source: post.source || "",
      tags,
    };
  }

  // Rule34.us -------------------------------------------------------------

  const RULE34_US_CATEGORIES = {
    artist: "artist",
    copyright: "copyright",
    character: "character",
    metadata: "meta",
  };

  function rule34Us(id) {
    const tags = [];
    for (const li of document.querySelectorAll('.tag-list-left li[class$="-tag"]')) {
      const type = /([\w]+)-tag/.exec(li.className)?.[1];
      const link = li.querySelector('a[href*="r=posts/index"]');
      const name = link && new URL(link.getAttribute("href"), location.href).searchParams.get("q");
      if (name) tags.push({ name, category: RULE34_US_CATEGORIES[type] || "general" });
    }
    const original = [...document.querySelectorAll('a[href*="/images/"]')].find((a) =>
      /^original$/i.test(a.textContent.trim()),
    );
    const video = document.querySelector("video source[src], video[src]");
    const sourceLine = sidebarField("Source");
    return {
      site: "Rule34.us",
      pageUrl: `https://rule34.us/index.php?r=posts/view&id=${id}`,
      fileUrl: absolute(original?.getAttribute("href") || video?.getAttribute("src")),
      // The site doesn't rate posts; all of it is for adults.
      rating: rating(metaContent('meta[name="rating"]')),
      source: sourceLine?.href || "",
      tags,
    };
  }

  // Zerochan --------------------------------------------------------------

  // Zerochan's tag types, by the class of their list item.
  const ZEROCHAN_CATEGORIES = {
    mangaka: "artist",
    artist: "artist",
    studio: "copyright",
    series: "copyright",
    game: "copyright",
    "visual novel": "copyright",
    "visual-novel": "copyright",
    franchise: "copyright",
    character: "character",
  };

  function zerochanFile() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        const url = [data].flat().map((d) => d?.contentUrl).find(Boolean);
        if (url) return absolute(url);
      } catch {
        // Try the next one.
      }
    }
    const link =
      document.querySelector("#large a.preview[href]") ||
      document.querySelector('a[href*="static.zerochan.net"][href*=".full."]');
    return link ? absolute(link.getAttribute("href")) : null;
  }

  function zerochan(id) {
    const tags = [];
    for (const li of document.querySelectorAll("ul#tags > li")) {
      const name = li.querySelector("a")?.textContent.trim();
      if (!name) continue;
      const type = [...li.classList].map((c) => c.toLowerCase()).find((c) => ZEROCHAN_CATEGORIES[c]);
      tags.push({ name, category: ZEROCHAN_CATEGORIES[type] || "general" });
    }
    return {
      site: "Zerochan",
      pageUrl: `https://www.zerochan.net/${id}`,
      fileUrl: zerochanFile(),
      rating: null,
      source: "",
      tags,
    };
  }

  // Which site and post ---------------------------------------------------

  const GELBOORUS = {
    "gelbooru.com": "Gelbooru",
    "safebooru.org": "Safebooru",
    "tbib.org": "TBIB",
    "rule34.xxx": "Rule34.xxx",
  };
  const MOEBOORUS = {
    "yande.re": "Yande.re",
    "konachan.com": "Konachan",
    "konachan.net": "Konachan",
  };

  // A reader for the post this page shows, or null when it isn't a post.
  function detect(loc = location) {
    const read = reader(loc);
    return (
      read &&
      (async () => {
        const post = await read();
        // A challenge or login page where the post should be.
        if (!post.fileUrl && post.tags.length === 0) {
          throw new Error("the post isn't on this page. Reload it, or log in to see it.");
        }
        return post;
      })
    );
  }

  function reader(loc) {
    const host = loc.hostname.replace(/^www\./, "");
    const path = loc.pathname;
    const params = new URLSearchParams(loc.search);
    let match;
    if (/(^|\.)donmai\.(us|moe)$/.test(host) && (match = /^\/posts\/(\d+)\/?$/.exec(path))) {
      return () => danbooru(match[1]);
    }
    if ((host === "e621.net" || host === "e926.net") && (match = /^\/posts\/(\d+)\/?$/.exec(path))) {
      return () => e621(match[1]);
    }
    if (GELBOORUS[host] && path === "/index.php") {
      const id = params.get("id");
      if (params.get("page") === "post" && params.get("s") === "view" && /^\d+$/.test(id || "")) {
        return () => gelbooru(id, GELBOORUS[host]);
      }
    }
    if (MOEBOORUS[host] && (match = /^\/post\/show\/(\d+)/.exec(path))) {
      return () => moebooru(match[1], MOEBOORUS[host]);
    }
    if (host === "rule34.us" && path === "/index.php") {
      const id = params.get("id");
      if (params.get("r") === "posts/view" && /^\d+$/.test(id || "")) return () => rule34Us(id);
    }
    if (host === "zerochan.net" && (match = /^\/(\d+)\/?$/.exec(path))) {
      return () => zerochan(match[1]);
    }
    return null;
  }

  globalThis.moekuraSites = { detect };
})();
