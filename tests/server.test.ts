import { afterEach, expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import { request } from "node:http";
import path from "node:path";
import { startServer } from "../src/server/server";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ev-http-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "web"));
  await mkdir(path.join(root, "web", "assets"));
  await writeFile(
    path.join(root, "web", "index.html"),
    '<meta name="ev-session" content="__EV_SESSION__">',
  );
  await mkdir(path.join(root, "files"));
  await mkdir(path.join(root, "other"));
  await writeFile(path.join(root, "files", "test.md"), "# Local");
  await writeFile(path.join(root, "other", "secret"), "secret");
  const opened: string[] = [];
  const server = await startServer({
    target: path.join(root, "files"),
    home: root,
    webRoot: path.join(root, "web"),
    opener: async (target) => {
      opened.push(target);
    },
  });
  cleanup.push(() => server.close());
  const html = await (await fetch(server.url)).text();
  const token = html.match(/content="([a-f0-9]+)"/)![1];
  const headers = { Origin: server.url, "X-EV-Session": token, "Content-Type": "application/json" };
  const api = async (op: string, data: Record<string, unknown> = {}) =>
    fetch(server.url + "/api", { method: "POST", headers, body: JSON.stringify({ op, ...data }) });
  return { root, server, headers, api, opened };
}
it("protects bootstrap and API from hostile Host/Origin, missing token, embedded/cross-site requests and paths in URL", async () => {
  const { server, headers } = await fixture();
  for (const extra of [
    { Origin: "https://attacker.test" },
    { Host: "attacker.test" },
    { "Sec-Fetch-Site": "cross-site" },
  ] as Record<string, string>[]) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(server.url, { headers: extra }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  }
  expect(
    (
      await fetch(server.url + "/api", {
        method: "POST",
        headers: { ...headers, "X-EV-Session": "wrong" },
        body: '{"op":"state"}',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(server.url + "/api", {
        method: "POST",
        headers: { ...headers, Origin: "null" },
        body: '{"op":"state"}',
      })
    ).status,
  ).toBe(403);
  expect((await fetch(server.url + "/api")).status).toBe(405);
  expect((await fetch(server.url + "/?path=/etc/passwd")).status).toBe(404);
  const root = await fetch(server.url);
  expect(root.headers.get("X-Frame-Options")).toBe("DENY");
  expect(root.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(root.headers.get("Access-Control-Allow-Origin")).toBeNull();
});
it("allows opaque-ID reads only and invalidates IDs when navigating/refreshing", async () => {
  const { api } = await fixture();
  const state = await (await api("state")).json();
  const list = await (await api("list", { id: state.root.id })).json();
  const id = list.entries[0].id;
  expect(id).not.toContain("/");
  expect((await (await api("read", { id })).json()).text).toBe("# Local");
  expect((await api("read", { id: "/etc/passwd" })).status).toBe(400);
  await api("parent");
  expect((await api("read", { id })).status).toBe(400);
});
it("blocks resource and symlink escapes, tolerates errors, and only opens explicit HTML", async () => {
  const { root, api, opened } = await fixture();
  await symlink(path.join(root, "other"), path.join(root, "files", "escape"));
  await writeFile(path.join(root, "files", "page.html"), "<h1>Page</h1>");
  const state = await (await api("state")).json();
  const list = await (await api("list", { id: state.root.id })).json();
  const html = list.entries.find((entry: { name: string }) => entry.name === "page.html");
  const text = list.entries.find((entry: { name: string }) => entry.name === "test.md");
  expect((await api("resource", { id: html.id, reference: "escape/secret" })).status).toBe(400);
  expect((await api("external", { id: text.id })).status).toBe(400);
  expect(opened).toEqual([]);
  expect((await api("external", { id: html.id })).status).toBe(200);
  expect(opened).toEqual([path.join(root, "files", "page.html")]);
  expect((await api("read", { id: text.id })).status).toBe(200);
});
