# Moekura Uploader

A browser extension that clones a post from another booru to your
[Moekura](https://github.com/moe-studios/moekura) site in one click: the
original file, its tags (with their categories), its rating and its source.

It works on the boorus Moekura knows:

| Site | Post pages |
|---|---|
| Danbooru (and its mirrors on `donmai.us`, `donmai.moe`) | `/posts/123` |
| e621, e926 | `/posts/123` |
| Gelbooru, Safebooru, TBIB, Rule34.xxx | `index.php?page=post&s=view&id=123` |
| Yande.re, Konachan | `/post/show/123` |
| Rule34.us | `index.php?r=posts/view&id=123` |
| Zerochan | `/123` |

Chrome (and other Chromium browsers) 121+ and Firefox 128+.

## Installing

**Chrome**: open `chrome://extensions`, turn on *Developer mode*, choose
**Load unpacked** and pick this folder.

**Firefox**: open `about:debugging#/runtime/this-firefox`, choose **Load
Temporary Add-on…** and pick `manifest.json`. A temporary add-on lasts until
Firefox restarts; to keep it, sign it with
[`web-ext sign`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign).

## Setting up

The settings page opens when the extension is installed (or from the
extension's menu → *Options*):

1. **Site address**: your Moekura site, such as `https://booru.example.com`.
2. **API key**: make one on your site under **Settings → API keys**. The
   account needs to be allowed to upload.
3. **Save**. The browser asks to let the extension reach your site; allow it.
   **Test connection** checks the key and says whom it signs in as.

Firefox may also ask for access to the boorus themselves; the settings page
shows a button for it when it does.

## Using it

On a post page, click **Clone to Moekura** in the bottom-right corner, the
extension's toolbar button, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd>.
The button shows the download's progress, then links to the new post.

- If the file is already on your site, it links to that post instead.
- If the file looks like posts already there, it lists them and offers
  **Upload anyway**, which posts the copy Moekura kept meanwhile without
  sending it again. Tick *Upload even when the file looks like posts already
  on the site* in the settings to skip the question.

You can hide the floating button in the settings and use the toolbar button
or the shortcut alone.

## What it copies

- **The file**: the original, not the sample a page shows, downloaded by your
  browser, so posts you can see while logged in to the booru can be cloned
  too. If the browser can't download it, the extension sends Moekura the
  link and Moekura downloads it itself.
- **Tags**, with their categories, the way `moekura admin import-remote` files
  them. Categories only apply to tags new to your site; tags that already
  exist keep theirs.

  | From | Becomes |
  |---|---|
  | artist; Moebooru's circle; Zerochan's mangaka | artist |
  | copyright; Zerochan's series, game, studio… | copyright |
  | character | character |
  | meta, metadata; e621's lore; Moebooru's faults | meta |
  | everything else, e621's species included | general |

  Tags Moekura would refuse (with `*`, starting with `-` or `~`, or with a
  search prefix such as `rating:`) are left out, so they can't sink the
  upload.
- **Rating**: Danbooru's `g`, `s`, `q`, `e` as they are. On the other sites,
  "safe" becomes general. Zerochan doesn't rate posts, so its posts get the
  rating chosen in the settings; Rule34.us posts are explicit.
- **Source**: the post's own source when it has one, otherwise its page on the
  booru. The settings can make it always the booru page.
- **Extra tags** from the settings, added to every post.

## Troubleshooting

- **"The post isn't on this page"**: the booru showed a challenge or login
  page. Reload it, or log in, and try again.
- **"Moekura didn't accept the API key"**: the key was revoked or mistyped;
  resetting your password revokes all your keys.
- **"Moekura refused the request as cross-site"**: something between the
  browser and your site (a proxy, or a browser that doesn't treat extension
  requests as the site's own) made the request look like it came from another
  website. Adding the extension's origin (`chrome-extension://<id>` or
  `moz-extension://<uuid>`) to `allowed_origins` under `[server.cors]` in
  `moekura.toml` lets it through.

## How it works

- `src/content/sites.js` reads the post off the booru page: Danbooru's and
  e621's JSON API (from the page, with your login), the page's own post data
  on Moebooru, and the sidebar everywhere else.
- `src/content/button.js` draws the button and passes the post to the
  background script.
- `src/background.js` downloads the file (sending the booru's page as the
  referrer, which Gelbooru's file servers want) and uploads it with
  `POST /api/v1/posts`.
- `src/options/` is the settings page; `src/settings.js` lists the settings and
  their defaults.

There's no build step: the folder is the extension. To make a package to
upload to a store, zip it:

```sh
zip -r moekura-uploader.zip manifest.json icons src
```

## Releasing

Set the new version in `manifest.json`, commit, and push a tag for it:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The release workflow checks the tag against the manifest, zips the extension
and publishes a GitHub release with the zip.

## License

[MIT](LICENSE).
