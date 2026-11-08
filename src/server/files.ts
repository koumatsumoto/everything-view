import { lstat, opendir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { isUtf8 } from "node:buffer";
import { randomBytes } from "node:crypto";
import { inside, UserError, Workspace } from "./workspace.js";
import type { GitChange } from "./git.js";
export const MAX_BYTES = 2 * 1024 * 1024;
export const mediaType = (target: string): string =>
  ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".css": "text/css",
    ".html": "text/html",
    ".htm": "text/html",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
  })[path.extname(target).toLowerCase()] ?? "text/plain";
export async function readRegular(
  target: string,
  limit = MAX_BYTES,
  root?: string,
): Promise<Buffer> {
  const handle = await open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new UserError("通常のファイルではありません。");
    if (info.size > limit)
      throw new UserError(
        `大きすぎるため表示できません（上限 ${Math.round(limit / 1024 / 1024)} MiB）。`,
      );
    if (root) {
      const actual = await realpath(
        process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : target,
      );
      if (!inside(root, actual)) throw new UserError("ファイルが表示範囲外です。");
      const current = await lstat(actual);
      if (current.ino !== info.ino || current.dev !== info.dev)
        throw new UserError("ファイルが変わりました。更新して再度選んでください。");
    }
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > limit) throw new UserError("読み込み中にファイルが上限サイズを超えました。");
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}
export async function readContent(target: string, root?: string) {
  const bytes = await readRegular(target, MAX_BYTES, root);
  const mime = mediaType(target);
  const binary =
    (bytes.includes(0) || !isUtf8(bytes)) &&
    !mime.startsWith("image/") &&
    mime !== "application/pdf";
  return {
    mime,
    binary,
    text:
      binary || mime.startsWith("image/") || mime === "application/pdf"
        ? ""
        : bytes.toString("utf8"),
    data: mime.startsWith("image/") || mime === "application/pdf" ? bytes.toString("base64") : "",
  };
}
export async function listDirectory(workspace: Workspace, target: string, changes: GitChange[]) {
  const entries = new Map<
    string,
    { name: string; directory: boolean; deleted: boolean; symlink: boolean }
  >();
  try {
    for await (const entry of await opendir(target)) {
      entries.set(entry.name, {
        name: entry.name,
        directory: entry.isDirectory(),
        deleted: false,
        symlink: entry.isSymbolicLink(),
      });
      if (entry.isSymbolicLink() && workspace.root) {
        try {
          const actual = await realpath(path.join(target, entry.name));
          if (inside(workspace.root, actual)) {
            const info = await lstat(actual);
            entries.get(entry.name)!.directory = info.isDirectory();
          }
        } catch {
          /* Broken links remain visible but cannot be followed. */
        }
      }
      if (entries.size >= 10000)
        throw new UserError(
          "1万件を超えるフォルダは表示できません。小さなフォルダを指定してください。",
        );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const change of changes) {
    const relative = path.relative(target, change.path);
    if (!inside(target, change.path) || !relative) continue;
    const [name, ...rest] = relative.split(path.sep);
    if (!entries.has(name))
      entries.set(name, { name, directory: rest.length > 0, deleted: true, symlink: false });
  }
  return [...entries.values()]
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
    .map((entry) => {
      const absolute = path.join(target, entry.name);
      return {
        ...entry,
        id: workspace.id(absolute),
        changed: changes.some((change) => inside(absolute, change.path)),
      };
    });
}
export async function searchHome(workspace: Workspace, query: string) {
  const needle = query.trim().toLocaleLowerCase().replaceAll("\\", "/");
  if (needle.length < 2) return { results: [], truncated: false };
  if (needle.length > 256) throw new UserError("検索文字列が長すぎます。");
  workspace.searchIds.clear();
  const home = await realpath(workspace.home);
  const pending = [home];
  const results: { id: string; name: string; displayPath: string; directory: boolean }[] = [];
  const deadline = Date.now() + 1800;
  let visited = 0;
  while (pending.length && Date.now() < deadline && visited < 30000 && results.length < 100) {
    const directory = pending.shift()!;
    try {
      for await (const entry of await opendir(directory)) {
        visited++;
        if (entry.name === "node_modules" || entry.name === ".git" || entry.isSymbolicLink())
          continue;
        const target = path.join(directory, entry.name);
        const relative = path.relative(home, target);
        if (relative.toLocaleLowerCase().split(path.sep).join("/").includes(needle)) {
          const id = randomBytes(18).toString("hex");
          workspace.searchIds.set(id, target);
          results.push({
            id,
            name: entry.name,
            displayPath: relative,
            directory: entry.isDirectory(),
          });
        }
        if (entry.isDirectory()) pending.push(target);
        if (Date.now() >= deadline || visited >= 30000 || results.length >= 100) break;
      }
    } catch {
      /* Permission errors do not stop a HOME search. */
    }
  }
  return { results, truncated: pending.length > 0 || results.length >= 100 || visited >= 30000 };
}
export async function openSearchResult(workspace: Workspace, id: unknown) {
  const candidate = typeof id === "string" ? workspace.searchIds.get(id) : undefined;
  if (!candidate) throw new UserError("もう一度検索して結果を選んでください。");
  const actual = await realpath(candidate);
  const home = await realpath(workspace.home);
  if (!inside(home, actual) || (await lstat(candidate)).isSymbolicLink())
    throw new UserError("検索結果がHOMEの範囲外です。");
  await workspace.open(actual);
}
