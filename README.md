# Everything View

A read-only local file and Git viewer. Run `ev` instead of opening an editor just
to inspect a folder. Nothing is sent off the machine, and no telemetry is used.

## Requirements and setup

- Node.js **24.11+ (24.x)** or **26+**, npm, and Git on PATH for Git views.
- First target: Ubuntu on WSL, viewed in a Windows browser through localhost.
- Windows/macOS/Linux launchers are provided, but native Windows/macOS and the
  WSL-to-Windows launcher still require real-machine acceptance testing.

```sh
npm ci
npm run check
npm link
```

```sh
ev             # HOME search, no folder opened yet
ev .           # current folder
ev /tmp        # explicit paths outside HOME are allowed
ev notes.md    # select the file, with its parent as the tree top
ev diff        # current folder, with Git diff selected on file clicks
```

The process stays in the foreground. **Ctrl+C stops its server.** Each invocation
has its own ephemeral loopback port. If automatic browser launch fails, open the
printed `http://localhost:PORT` URL. `EV_NO_OPEN=1` suppresses automatic launch
for tests/headless use. `ev --help` prints a short usage summary.

In WSL, the CLI/server/Git and HOME are all Linux-side. The launcher uses Windows
PowerShell to open localhost in the Windows default browser. Explicit external
HTML opening converts the path with `wslpath -w`; failure is shown in the UI.
The viewer binds **127.0.0.1 only**. Use exactly the printed localhost hostname;
other Host headers, including the numeric IP hostname, are intentionally rejected.

## Viewing

- Search HOME by a name or partial relative path, using at least two characters.
  Search runs **only when submitted**, skips `.git`, `node_modules`, and symlinks,
  and stops at 100 results, 30,000 entries, or approximately 1.8 seconds. Narrow a
  truncated search. It does not scan the whole disk.
- Click a folder to expand its children. The normal tree **does include** `.git`
  and `node_modules`. Right-click any folder to use it as the top. Right-click the
  top name or use ↑ to show one parent level. Those explicit actions change the
  server-side browsing scope.
- Click a file for Preview, then choose Code or Diff. Markdown (GFM), isolated HTML,
  raster images, and PDF pages are supported. SVG is source-only. Text Code view
  is plain text, not an editor. Maximum individual file/resource/Git output size
  is **2 MiB**. Unsupported binaries and unavailable files show an explanation.
- HTML/Markdown cannot run scripts, submit forms, navigate, or load external
  resources. Relative raster images and local CSS within the visible top work.
  CSS imports, URL-valued CSS, fonts, SVG resources, and active media are omitted.
  At most 40 image/stylesheet resources are considered per document. Preview links
  are disabled. To deliberately run an HTML file, use **Open HTML in external
  browser**. That external browser is outside EV's preview restrictions.
- PDF.js, its worker, CMaps, standard fonts, and WASM decoders are bundled. Pages are canvas-only, without annotation
  links, actions, JavaScript, XFA, or attachments. Enormous pages are rejected.
- Git changes, new files, deleted paths, and containing folders share one accent
  color. There is no separate changes list. A top inside a repository detects the
  parent repository, but marks only paths below the visible top.
- Diff shows **unstaged: index → working tree** or **staged: HEAD → index**, with
  before on the left and after on the right. Untracked files are empty → current
  on the unstaged side. Deleted files, rename sources, unborn HEAD, binary content,
  and unmerged files are handled explicitly. Everything View never stages,
  commits, saves, or updates the Git index.
- Refresh reloads Git, the tree, and the selected file. Tree expansion is reset.
  There is no filesystem watcher, automatic reload, background daemon, or reuse.

## Security boundary

The current top is kept on the server. Browsing requests use random opaque IDs
in JSON request bodies, never real paths in URLs. Parent/top/search-result actions
are the only UI operations that expand scope. Old browsing IDs are discarded on
navigation and refresh. Symlink escapes and unselected paths are refused.

The API requires the exact Host/port, same Origin, and a random session header.
There is no CORS access, and the main UI rejects framing. HTML/Markdown previews
use a script-free opaque-origin sandbox and a restrictive CSP. Local preview
assets are validated and embedded as data, without the API session value. Git is
spawned without a shell; external diff/textconv are never invoked, fsmonitor is
disabled, and optional locks are disabled. The server logs no file paths, tokens,
or file contents. Treat the terminal and the browser as trusted local clients.
Other users/programs already running on the same machine are not an authentication
boundary; do not expose or reverse-proxy this server.

## Development and verification

The npm-local Vite+ CLI runs Vite, Vitest, Oxlint, Oxfmt, and tsdown (`vp pack`).
The `vite` npm alias is required by Vite+'s Vitest integration. TypeScript is
strict and pinned. No React, Express, Biome, or alternative package manager is used.

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run check                 # all the above
npm audit --audit-level=low
node scripts/pack-smoke.mjs   # pack, install into temp dir, start packaged CLI
npm pack                     # distributable tarball, builds via prepack
```

Browser acceptance uses Python 3.12+, Playwright **1.62.0**, and Chromium. Install
those separately in a test environment, then run `npm run build && npm run test:browser`.
The test uses `/usr/bin/chromium` if present, otherwise Playwright's installed
Chromium; `CHROMIUM_PATH` overrides it. It creates only temporary local files,
starts a local receiver, and checks that document previews send it no requests.
CI runs type/lint/format/unit/build/audit/packed-install/browser checks on the
latest Node 24 and 26. The test never downloads a browser automatically.

```sh
python -m pip install playwright==1.62.0
python -m playwright install chromium
npm run test:browser
```

### Manual WSL/Windows acceptance still required

On Ubuntu WSL, run the CLI commands above and confirm Windows browser startup,
HOME search, `/tmp`, file/folder entry, both right-click actions, refresh, and
Ctrl+C. Run two viewers and confirm separate ports. Select staged/unstaged,
untracked/deleted/rename, Japanese/space names, a partial repository subtree, and
Git-free folders. Try Markdown/HTML local images and CSS, blocked remote content,
PDF pages, symlinks outside the top, and an explicit external HTML open. Native
macOS/Windows launching and full OS-specific path behavior are not claimed verified.

## Layout and distribution

`src/cli.ts` handles startup; `src/server/` owns the filesystem, Git, preview asset
boundary and HTTP server. `src/web/` contains framework-free TypeScript/CSS/HTML.
`tests/` covers scope/HTTP/Git and browser flows. `scripts/` verifies packaging and
retains licenses. `dist/` is generated and ignored by Git.

The tarball contains `dist/cli.mjs`, built web assets, the PDF.js worker/CMaps/fonts/WASM, and full
third-party licenses. There are **no runtime npm dependencies** and no CDN use.
The first release deliberately omits fuzzy CLI paths, editing, remote access,
persistent servers, and a separate changed-files view. Requirements: [issue #1](https://github.com/koumatsumoto/everything-view/issues/1).
