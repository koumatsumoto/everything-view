import path from "node:path";
import { realpath } from "node:fs/promises";
import { mediaType, readRegular } from "./files.js";
import { inside, UserError, Workspace } from "./workspace.js";
export async function localResource(workspace: Workspace, id: unknown, reference: unknown) {
  if (
    typeof reference !== "string" ||
    reference.length > 4096 ||
    [...reference].some((char) => char.charCodeAt(0) < 32 || char === "\\")
  )
    throw new UserError("無効なローカル資源です。");
  if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/iu.test(reference))
    throw new UserError("相対パスのローカル資源だけを表示できます。");
  let relative: string;
  try {
    relative = decodeURIComponent(reference.split(/[?#]/u)[0]);
  } catch {
    throw new UserError("無効な資源パスです。");
  }
  if (
    [...relative].some((char) => char.charCodeAt(0) < 32 || char === "\\" || char === ":") ||
    path.isAbsolute(relative)
  )
    throw new UserError("無効な資源パスです。");
  const base = await workspace.resolve(id);
  const candidate = path.resolve(path.dirname(base), relative);
  if (!workspace.root || !inside(workspace.root, candidate))
    throw new UserError("資源が表示範囲外です。");
  const actual = await realpath(candidate);
  if (!inside(workspace.root, actual)) throw new UserError("資源のリンク先が表示範囲外です。");
  const mime = mediaType(actual);
  // SVG can contain active subresources. Only inert raster images and CSS are loaded.
  if (
    ![
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/avif",
      "image/bmp",
      "image/x-icon",
      "text/css",
    ].includes(mime)
  )
    throw new UserError("この種類の資源はプレビューに読み込めません。");
  const bytes = await readRegular(actual, 2 * 1024 * 1024, workspace.root);
  return {
    id: workspace.id(actual),
    mime,
    data: bytes.toString("base64"),
    text: mime === "text/css" ? bytes.toString("utf8") : "",
  };
}
