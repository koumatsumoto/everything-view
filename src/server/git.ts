import { execFile } from "node:child_process";
import path from "node:path";
import { isUtf8 } from "node:buffer";
import { readRegular } from "./files.js";
import { inside, UserError } from "./workspace.js";
export interface GitChange {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
}
export interface GitDiff {
  before: string;
  after: string;
  binary: boolean;
  message?: string;
  notice?: string;
}
const LIMIT = 2 * 1024 * 1024;
async function git(repo: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "diff.external=",
        "-c",
        "core.pager=cat",
        "-C",
        repo,
        ...args,
      ],
      {
        encoding: "buffer",
        maxBuffer: LIMIT,
        timeout: 6000,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
          GIT_EXTERNAL_DIFF: "",
          GIT_CONFIG_COUNT: "0",
        },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}
export async function detectRepository(top: string): Promise<string | null> {
  try {
    return (await git(top, ["rev-parse", "--show-toplevel"]))
      .toString("utf8")
      .replace(/\r?\n$/u, "");
  } catch {
    return null;
  }
}
export async function getStatus(repo: string, top: string): Promise<GitChange[]> {
  const relative = path.relative(repo, top).split(path.sep).join("/") || ".";
  const records = (
    await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", relative])
  )
    .toString("utf8")
    .split("\0");
  const result: GitChange[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const target = path.resolve(repo, record.slice(3));
    const change: GitChange = { path: target, indexStatus: record[0], worktreeStatus: record[1] };
    if ("RC".includes(record[0]) || "RC".includes(record[1]))
      change.originalPath = path.resolve(repo, records[++i]);
    if (inside(top, target)) result.push(change);
    // A rename leaving the subtree still needs a deleted source entry.
    if (change.originalPath && inside(top, change.originalPath) && !inside(top, target))
      result.push({ ...change, path: change.originalPath, indexStatus: "D" });
  }
  return result;
}
async function blob(repo: string, rev: string, target: string): Promise<Buffer> {
  const relative = path.relative(repo, target).split(path.sep).join("/");
  if (!inside(repo, target)) throw new Error("Path outside repository.");
  try {
    return await git(repo, ["cat-file", "blob", `${rev}:${relative}`]);
  } catch (error) {
    if ((error as { code?: number }).code === 128 || (error as { code?: number }).code === 1)
      return Buffer.alloc(0);
    throw error;
  }
}
export async function readDiff(
  repo: string,
  file: string,
  stage: "staged" | "unstaged",
  changes: GitChange[],
  root?: string,
): Promise<GitDiff> {
  const boundary = root ?? repo;
  if (!inside(boundary, file)) throw new UserError("比較対象が表示範囲外です。");
  const change = changes.find((item) => item.path === file);
  if (
    change &&
    (change.indexStatus === "U" ||
      change.worktreeStatus === "U" ||
      ["AA", "DD"].includes(change.indexStatus + change.worktreeStatus))
  )
    return {
      before: "",
      after: "",
      binary: false,
      message: "競合が未解決です。Everything Viewの外で解決してください。",
    };
  let before: Buffer, after: Buffer;
  let notice: string | undefined;
  if (stage === "staged") {
    const source = change?.originalPath ?? file;
    if (!inside(boundary, source)) {
      before = Buffer.alloc(0);
      notice = "移動元が表示範囲外のため、変更前は読み込まず追加として表示します。";
    } else before = await blob(repo, "HEAD", source);
    after = await blob(repo, "", file);
  } else {
    before = change?.indexStatus === "?" ? Buffer.alloc(0) : await blob(repo, "", file);
    try {
      after = await readRegular(file, LIMIT, root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") after = Buffer.alloc(0);
      else throw error;
    }
  }
  if (before.includes(0) || after.includes(0) || !isUtf8(before) || !isUtf8(after))
    return {
      before: "",
      after: "",
      binary: true,
      message: "バイナリの差分はテキスト表示できません。",
    };
  return {
    before: before.toString("utf8"),
    after: after.toString("utf8"),
    binary: false,
    ...(notice ? { notice } : {}),
  };
}
