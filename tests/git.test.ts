import { afterEach, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectRepository, getStatus, readDiff } from "../src/server/git";
import { listDirectory } from "../src/server/files";
import { Workspace } from "../src/server/workspace";
const dirs: string[] = [];
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_COUNT: "0" },
  });
}
async function repo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ev-git-"));
  dirs.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "EV test");
  git(root, "config", "user.email", "ev@example.test");
  return root;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
it("reads staged/unstaged/rename/deletion/untracked/Japanese paths without changing index", async () => {
  const root = await repo();
  await mkdir(path.join(root, "sub"));
  for (const name of ["両方 space.txt", "delete.txt", "old.txt"])
    await writeFile(path.join(root, "sub", name), "before\n");
  await writeFile(path.join(root, "outside.txt"), "outside\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const file = path.join(root, "sub", "両方 space.txt");
  await writeFile(file, "staged\n");
  git(root, "add", ".");
  await writeFile(file, "unstaged\n");
  await rm(path.join(root, "sub", "delete.txt"));
  await rename(path.join(root, "sub", "old.txt"), path.join(root, "sub", "new name.txt"));
  git(root, "add", "sub/old.txt", "sub/new name.txt");
  await writeFile(path.join(root, "sub", "new.txt"), "untracked\n");
  await writeFile(path.join(root, "outside.txt"), "not in subtree\n");
  const sub = path.join(root, "sub");
  expect(await detectRepository(sub)).toBe(root);
  const indexBefore = await readFile(path.join(root, ".git", "index"));
  const mtime = (await stat(path.join(root, ".git", "index"))).mtimeMs;
  const changes = await getStatus(root, sub);
  expect(changes.every((change) => change.path.startsWith(sub + path.sep))).toBe(true);
  expect(changes.some((change) => change.path.endsWith("outside.txt"))).toBe(false);
  expect(await readDiff(root, file, "staged", changes, sub)).toMatchObject({
    before: "before\n",
    after: "staged\n",
  });
  expect(await readDiff(root, file, "unstaged", changes, sub)).toMatchObject({
    before: "staged\n",
    after: "unstaged\n",
  });
  expect(
    await readDiff(root, path.join(sub, "delete.txt"), "unstaged", changes, sub),
  ).toMatchObject({ before: "before\n", after: "" });
  expect(await readDiff(root, path.join(sub, "new.txt"), "unstaged", changes, sub)).toMatchObject({
    before: "",
    after: "untracked\n",
  });
  expect(
    await readDiff(root, path.join(sub, "new name.txt"), "staged", changes, sub),
  ).toMatchObject({ before: "before\n", after: "before\n" });
  const ws = new Workspace(root);
  await ws.open(sub);
  const entries = await listDirectory(ws, sub, changes);
  expect(entries.find((entry) => entry.name === "delete.txt")).toMatchObject({
    deleted: true,
    changed: true,
  });
  expect(await readFile(path.join(root, ".git", "index"))).toEqual(indexBefore);
  expect((await stat(path.join(root, ".git", "index"))).mtimeMs).toBe(mtime);
});
it("handles unborn HEAD, binary and Git-free folders", async () => {
  const root = await repo();
  await writeFile(path.join(root, "first"), "first\n");
  git(root, "add", ".");
  const changes = await getStatus(root, root);
  expect(await readDiff(root, path.join(root, "first"), "staged", changes, root)).toMatchObject({
    before: "",
    after: "first\n",
  });
  await writeFile(path.join(root, "binary"), Buffer.from([0, 1, 2]));
  expect(
    await readDiff(root, path.join(root, "binary"), "unstaged", await getStatus(root, root), root),
  ).toMatchObject({ binary: true });
  const other = await mkdtemp(path.join(os.tmpdir(), "ev-no-git-"));
  dirs.push(other);
  expect(await detectRepository(other)).toBeNull();
});
it("never invokes configured fsmonitor, textconv, or external diff", async () => {
  const root = await repo();
  await writeFile(path.join(root, "file"), "before");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  await writeFile(path.join(root, "file"), "after");
  const marker = path.join(root, "executed");
  const command = `touch ${marker}`;
  git(root, "config", "core.fsmonitor", command);
  git(root, "config", "diff.external", command);
  git(root, "config", "diff.evil.textconv", command);
  await writeFile(path.join(root, ".gitattributes"), "* diff=evil\n");
  const changes = await getStatus(root, root);
  await readDiff(root, path.join(root, "file"), "staged", changes, root);
  await readDiff(root, path.join(root, "file"), "unstaged", changes, root);
  await expect(stat(marker)).rejects.toThrow();
});
it("does not disclose a rename source outside the visible top", async () => {
  const root = await repo();
  const sub = path.join(root, "visible");
  await mkdir(sub);
  const original = path.join(root, "private-old.txt"),
    moved = path.join(sub, "moved.txt");
  await writeFile(original, "common one\ncommon two\ncommon three\nprivate-old-secret\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  await rename(original, moved);
  await writeFile(moved, "common one\ncommon two\ncommon three\npublic current\n");
  git(root, "add", "-A");
  const scoped = await getStatus(root, sub);
  const all = await getStatus(root, root);
  expect(all.find((change) => change.path === moved)?.originalPath).toBe(original);
  const scopedDiff = await readDiff(root, moved, "staged", scoped, sub);
  expect(scopedDiff.before).not.toContain("private-old-secret");
  expect(scopedDiff.after).toContain("public current");
  // Defensive enforcement still holds if a Git version/status provider includes
  // the original path even for a destination-only subtree query.
  const defensive = await readDiff(
    root,
    moved,
    "staged",
    all.filter((change) => change.path === moved),
    sub,
  );
  expect(defensive.before).toBe("");
  expect(defensive.after).toContain("public current");
  expect(defensive.notice).toContain("表示範囲外");
  await expect(readDiff(root, original, "staged", all, sub)).rejects.toThrow();
});
