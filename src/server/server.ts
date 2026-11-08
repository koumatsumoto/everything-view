import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace, UserError } from "./workspace.js";
import { listDirectory, readContent, openSearchResult, searchHome, mediaType } from "./files.js";
import { detectRepository, getStatus, readDiff, type GitChange } from "./git.js";
import { localResource } from "./preview.js";
import { openBrowser } from "./browser.js";
export interface ServerOptions {
  target?: string;
  diff?: boolean;
  home?: string;
  webRoot?: string;
  opener?: (target: string, isFile?: boolean) => Promise<void>;
}
export async function startServer(options: ServerOptions = {}) {
  const workspace = new Workspace(options.home ?? homedir());
  if (options.target) await workspace.open(options.target);
  const token = randomBytes(32).toString("hex");
  const webRoot = options.webRoot ?? fileURLToPath(new URL("./web/", import.meta.url));
  const assets = new Map<string, Buffer>();
  const index = (await readFile(path.join(webRoot, "index.html"), "utf8")).replace(
    "__EV_SESSION__",
    token,
  );
  for (const name of await readdir(path.join(webRoot, "assets")))
    if (/^[\w.-]+$/u.test(name))
      assets.set(`/assets/${name}`, await readFile(path.join(webRoot, "assets", name)));
  let repo: string | null = null,
    changes: GitChange[] = [];
  const refresh = async () => {
    repo = workspace.root ? await detectRepository(workspace.root) : null;
    changes = repo && workspace.root ? await getStatus(repo, workspace.root) : [];
  };
  const state = () => ({
    root: workspace.root
      ? {
          id: workspace.id(workspace.root),
          name: path.basename(workspace.root) || workspace.root,
          displayPath: workspace.root,
          canParent: path.dirname(workspace.root) !== workspace.root,
        }
      : null,
    selected: workspace.selected
      ? { id: workspace.id(workspace.selected), name: path.basename(workspace.selected) }
      : null,
    repository: repo ? path.basename(repo) : null,
    diffMode: options.diff ?? false,
  });
  await refresh();
  const opener = options.opener ?? openBrowser;
  async function operation(body: Record<string, unknown>) {
    switch (body.op) {
      case "state":
        return state();
      case "list":
        return {
          entries: await listDirectory(workspace, await workspace.resolve(body.id, true), changes),
        };
      case "search":
        return searchHome(workspace, typeof body.query === "string" ? body.query : "");
      case "openSearch":
        await openSearchResult(workspace, body.id);
        await refresh();
        return state();
      case "parent":
        await workspace.parent();
        await refresh();
        return state();
      case "top":
        await workspace.top(body.id);
        await refresh();
        return state();
      case "read": {
        const target = await workspace.resolve(body.id);
        workspace.selected = target;
        return readContent(target, workspace.root!);
      }
      case "resource":
        return localResource(workspace, body.id, body.reference);
      case "diff": {
        if (!repo)
          return {
            before: "",
            after: "",
            binary: false,
            message: "表示中のフォルダはGit管理外です。",
          };
        if (body.stage !== "staged" && body.stage !== "unstaged")
          throw new UserError("比較対象を選んでください。");
        const target = await workspace.resolve(body.id, true);
        workspace.selected = target;
        return readDiff(repo, target, body.stage, changes, workspace.root!);
      }
      case "refresh": {
        // Old IDs are invalidated after changes to scope or the filesystem.
        const selected = workspace.selected;
        workspace.ids.clear();
        await refresh();
        if (selected) {
          try {
            await workspace.resolve(workspace.id(selected), true);
          } catch {
            workspace.selected = null;
          }
        }
        return state();
      }
      case "external": {
        const target = await workspace.resolve(body.id);
        if (mediaType(target) !== "text/html")
          throw new UserError("外部ブラウザで開けるのはHTMLだけです。");
        await opener(target, true);
        return { ok: true };
      }
      default:
        throw new UserError("不明な操作です。");
    }
  }
  let origin = "";
  let queue = Promise.resolve();
  const server = createServer((request, response) => {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    };
    for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
    const reject = (status: number) => {
      response.writeHead(status, { "Content-Type": "text/plain" });
      response.end("このリクエストは拒否されました。");
    };
    const allowedHost = new URL(origin).host;
    if (
      request.headers.host !== allowedHost ||
      (request.headers.origin && request.headers.origin !== origin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    )
      return reject(403);
    if (request.url === "/api" && request.method !== "POST") return reject(405);
    if (request.url === "/api" && request.method === "POST") {
      const supplied = request.headers["x-ev-session"];
      if (
        request.headers.origin !== origin ||
        typeof supplied !== "string" ||
        !/^[a-f0-9]{64}$/u.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token)) ||
        !/^application\/json(?:;|$)/iu.test(request.headers["content-type"] ?? "")
      )
        return reject(403);
      // Serialize mutating navigation/search with reads so old capabilities cannot race a scope change.
      queue = queue
        .then(async () => {
          try {
            const body = await readBody(request);
            const result = await operation(body);
            json(response, 200, result);
          } catch (error) {
            json(response, error instanceof UserError ? 400 : 422, {
              error:
                error instanceof UserError
                  ? error.message
                  : "この項目を読み込めません。アクセス権を確認し、フォルダを更新してください。",
            });
          }
        })
        .catch(() => {
          if (!response.writableEnded) reject(500);
        });
      return;
    }
    if (request.method !== "GET") return reject(405);
    if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(index);
      return;
    }
    const asset = assets.get(request.url ?? "");
    if (!asset) return reject(404);
    const type =
      request.url!.endsWith(".js") || request.url!.endsWith(".mjs")
        ? "text/javascript"
        : request.url!.endsWith(".css")
          ? "text/css"
          : "application/octet-stream";
    response.writeHead(200, { "Content-Type": type });
    response.end(asset);
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxRequestsPerSocket = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind loopback.");
  origin = `http://localhost:${address.port}`;
  return {
    url: origin,
    workspace,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body) > 16384) throw new UserError("リクエストが大きすぎます。");
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new UserError("JSON形式が不正です。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new UserError("リクエストが不正です。");
  return value as Record<string, unknown>;
}
function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}
