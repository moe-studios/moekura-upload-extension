// The settings and what they are until changed, shared by the background
// script and the options page.

"use strict";

globalThis.MOEKURA_DEFAULTS = {
  instanceUrl: "",
  apiKey: "",
  // For sites that don't rate posts (Zerochan).
  defaultRating: "q",
  // "original": the post's own source when it has one, else its page on
  // the booru (as `moekura admin import-remote` does); "page": always the
  // booru page.
  sourceMode: "original",
  extraTags: "",
  allowSimilar: false,
  showButton: true,
};
