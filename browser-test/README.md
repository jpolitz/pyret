# browser-test — hover in the Pyret VS Code **web** extension

Headless proof that the Pyret VS Code extension serves **hover** (function
signature + docstring) in the **browser** build, plus a server you can open in a
browser to try it by hand.

Adapted from [`jpolitz/pyret-lang@drydock`]'s `browser-test/` harness (Playwright
+ `@vscode/test-web`, driving real VS Code for the Web headlessly). That harness
exercised the CPO editor webview; this one targets LSP-style hover.

## How browser hover works here

The desktop LSP computes hover by querying a `pyret.jarr -serve` process over a
socket (`lsp/src/server-node-tmp.ts` → `query.arr:hover`). A browser can't fork a
process, but `pyret.jarr`'s `--port` also accepts a **TCP** port, and the web
extension host (a Web Worker) has a native `WebSocket`. So:

```
Monaco hover  ──►  webExtension.ts PyretHoverProvider  ──ws://──►  pyret.jarr -serve (TCP)
   (browser)          (registerHoverProvider 'pyret')               (real query.arr:hover)
        ◄── vscode.Hover (```pyret <name> :: <ann>``` + doc) ◄── {name, ann, doc} ◄──
```

The hover *computation* is the exact same compiler logic verified on the desktop
LSP — no reimplementation. `webExtension.ts` renders `{name, ann, doc}` into the
same Markdown the desktop handler produces.

### Two settings (in the fixture's `.vscode/settings.json`)

- `pyret-parley.hover.serverUrl` — the companion server (`ws://localhost:5555`).
- `pyret-parley.hover.diskRoot` — absolute dir on the server's host holding the
  `.arr` files. The Web workspace is virtual, so the extension maps each open
  document to `<diskRoot>/<basename>` when querying. Hover therefore reflects the
  file **on disk** (like the desktop LSP, which compiles on save).

`*.arr` is associated with the default (text) editor so hover fires in Monaco;
the CPO custom editor is still available via **Reopen With…** (its priority was
lowered to `option`).

## Run the headless test

```bash
# prereqs: lang built (lang/build/phaseA/pyret.jarr) and vscode extension built
#          (cd vscode && npm install && npm run compile)
cd browser-test && npm install       # playwright + @vscode/test-web + ws
npm run hover                        # boots VS Code Web, hovers, asserts tooltips
```

It starts the companion server, opens `hover-test.arr` as text, hovers
`not-zero` / `div-refine` / `doc-no-ann`, and asserts the `.monaco-hover` tooltip
shows the signature and docstring.

## Try it in a browser

```bash
cd browser-test && node serve-3000.js
```

Then open the proxied URL for this box (`https://<vm>.exe.xyz:3000/`), open
`hover-test.arr` from the Explorer, and hover a function name (e.g. `not-zero`).

Everything is served on **one origin (`:3000`)** because the exe.dev proxy
authenticates per host:port and a background WebSocket can't do an interactive
login. `serve-3000.js` runs a small reverse proxy on `:3000`:

```
http(s)://<vm>:3000/            -> VS Code for the Web   (internal :3001)
ws(s)://<vm>:3000/pyret-hover   -> pyret.jarr -serve      (internal :5555)
```

The demo workspace sets `pyret-parley.hover.serverUrl` to
`wss://pyret-dev.exe.xyz:3000/pyret-hover`, so the hover WebSocket rides the
same already-authenticated origin. If you reach the box under a different
hostname, update that setting (in `vscode/demo-workspace/.vscode/settings.json`)
to match. Hover reflects the file **on disk** at `pyret-parley.hover.diskRoot`.

## Layout

```
serve-3000.js                       VS Code Web + hover server for manual testing
tests/hover.test.js                 node:test spec: hover -> assert tooltip
envs/vscode-hover.js                boot @vscode/test-web, open file as text
shared/pyret-server.js              start/stop the companion pyret.jarr -serve
shared/browser.js                   launch headless Chromium (from drydock)
vscode/fixture-workspace/           hover-test.arr + .vscode/settings.json
```

[`jpolitz/pyret-lang@drydock`]: https://github.com/jpolitz/pyret-lang/tree/drydock/browser-test
