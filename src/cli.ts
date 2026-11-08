#!/usr/bin/env node
import path from "node:path";
import { startServer } from "./server/server.js";
import { openBrowser } from "./server/browser.js";
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Everything View\n\n  ev          HOMEを検索\n  ev <path>   ファイル・フォルダを表示\n  ev diff     現在のフォルダのGit差分を表示\n\nCtrl+Cで終了。ファイルとGitは閲覧専用です。",
  );
} else if (args.length > 1) {
  console.error("使い方: ev [パス | diff]");
  process.exitCode = 1;
} else {
  try {
    const diff = args[0] === "diff";
    const server = await startServer({
      target: args[0] ? path.resolve(diff ? "." : args[0]) : undefined,
      diff,
    });
    console.log(`Everything View: ${server.url}\n閲覧専用です。Ctrl+Cで終了します。`);
    const shutdown = () => {
      void server.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    if (process.env.EV_NO_OPEN !== "1")
      void openBrowser(server.url).catch(() =>
        console.error("ブラウザを起動できませんでした。上のlocalhost URLを開いてください。"),
      );
  } catch {
    console.error("起動できませんでした。指定パスの存在とアクセス権を確認してください。");
    process.exitCode = 1;
  }
}
