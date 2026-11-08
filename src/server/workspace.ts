import { randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

export class UserError extends Error {}
export const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
};
export class Workspace {
  root: string | null = null;
  selected: string | null = null;
  readonly ids = new Map<string, string>();
  readonly searchIds = new Map<string, string>();
  readonly home: string;
  constructor(home: string) {
    this.home = home;
  }
  id(target: string): string {
    for (const [id, candidate] of this.ids) if (target === candidate) return id;
    const id = randomBytes(18).toString("hex");
    this.ids.set(id, target);
    return id;
  }
  async open(target: string): Promise<void> {
    const resolved = await realpath(target);
    const info = await stat(resolved);
    if (!info.isDirectory() && !info.isFile())
      throw new UserError("通常のファイル・フォルダだけを開けます。");
    this.root = info.isDirectory() ? resolved : path.dirname(resolved);
    this.selected = info.isFile() ? resolved : null;
    this.ids.clear();
    this.searchIds.clear();
  }
  async resolve(id: unknown, missing = false): Promise<string> {
    if (typeof id !== "string") throw new UserError("有効な項目を選んでください。");
    const target = this.ids.get(id);
    if (!target || !this.root || !inside(this.root, target))
      throw new UserError("この項目は表示範囲から外れました。フォルダを更新してください。");
    try {
      const actual = await realpath(target);
      if (!inside(this.root, actual))
        throw new UserError(
          "このシンボリックリンクは表示範囲外です。対象をCLIから直接指定してください。",
        );
      return actual;
    } catch (error) {
      if (missing && (error as NodeJS.ErrnoException).code === "ENOENT") {
        // Deleted Git paths still have to have an in-scope, non-symlink parent.
        let parent = path.dirname(target);
        for (;;) {
          try {
            const actual = await realpath(parent);
            if (!inside(this.root, actual)) throw new UserError("表示範囲外のパスです。");
            break;
          } catch (parentError) {
            if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
            const next = path.dirname(parent);
            if (next === parent) throw new UserError("このパスは利用できません。");
            parent = next;
          }
        }
        return target;
      }
      throw error;
    }
  }
  async parent(): Promise<void> {
    if (!this.root) throw new UserError("先にフォルダを開いてください。");
    const parent = path.dirname(this.root);
    await this.open(parent);
  }
  async top(id: unknown): Promise<void> {
    const target = await this.resolve(id);
    if (!(await lstat(target)).isDirectory()) throw new UserError("フォルダを選んでください。");
    await this.open(target);
  }
}
