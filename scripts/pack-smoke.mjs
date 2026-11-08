import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
const directory = await mkdtemp(path.join(os.tmpdir(), "ev-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let child;
try {
  const info = JSON.parse(
    execFileSync(npm, ["pack", "--json", "--ignore-scripts"], { encoding: "utf8" }),
  )[0];
  const tarball = path.resolve(info.filename);
  try {
    const install = path.join(directory, "install");
    execFileSync(
      npm,
      [
        "install",
        "--prefix",
        install,
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
      { stdio: "pipe" },
    );
    const root = path.join(install, "node_modules", "@koumatsumoto", "everything-view");
    await readFile(path.join(root, "dist", "THIRD_PARTY_LICENSES.txt"));
    child = spawn(process.execPath, [path.join(root, "dist", "cli.mjs"), directory], {
      env: { ...process.env, EV_NO_OPEN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const url = await Promise.race([
      new Promise((resolve, reject) => {
        let output = "";
        child.stdout.on("data", (data) => {
          output += data.toString();
          const match = output.match(/http:\/\/localhost:\d+/u);
          if (match) resolve(match[0]);
        });
        child.once("exit", () => reject(new Error("Packaged CLI exited before startup.")));
      }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Packaged CLI startup timed out.")), 10000);
        timer.unref();
      }),
    ]);
    const response = await fetch(url);
    if (!response.ok) throw new Error("Packaged HTML unavailable.");
    const html = await response.text();
    for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/gu)) {
      if (!(await fetch(url + match[1])).ok) throw new Error("Packaged asset missing.");
    }
    if (!info.files.some((file) => /pdf\.worker.*\.mjs$/u.test(file.path)))
      throw new Error("PDF worker missing.");
    console.log(
      "PASS: packed CLI installed without runtime dependencies; HTML, assets, worker and licenses present.",
    );
  } finally {
    await rm(tarball, { force: true });
  }
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGINT");
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
