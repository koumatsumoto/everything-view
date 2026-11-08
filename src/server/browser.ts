import { execFile } from "node:child_process";
import { release } from "node:os";
import { pathToFileURL } from "node:url";
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      command,
      args,
      { timeout: 6000, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) =>
        error
          ? reject(
              new Error(
                "外部ブラウザを起動できません。表示されたlocalhost URLを開くか、OSの起動設定を確認してください。",
              ),
            )
          : resolve(stdout.trim()),
    ),
  );
}
const wsl = () =>
  process.platform === "linux" &&
  (/microsoft/iu.test(release()) || Boolean(process.env.WSL_DISTRO_NAME));
export async function openBrowser(target: string, isFile = false): Promise<void> {
  let url = target;
  if (isFile) {
    if (wsl()) {
      const windowsPath = await run("wslpath", ["-w", target]);
      url = pathToFileURL(windowsPath, { windows: true }).href;
    } else url = pathToFileURL(target).href;
  }
  if (process.platform === "win32" || wsl()) {
    const command = `Start-Process -FilePath '${url.replaceAll("'", "''")}'`;
    await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64"),
    ]);
  } else if (process.platform === "darwin") await run("open", [url]);
  else await run("xdg-open", [url]);
}
