"""Real Chromium offline/sandbox smoke tests. Requires Python Playwright and Chromium.
Run after npm run build. No browser install/download occurs in this script.
"""
import base64
import http.server
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import threading
import time
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
requests = []
class Receiver(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        requests.append(self.path)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"untrusted")
    def log_message(self, *_args):
        pass

receiver = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
threading.Thread(target=receiver.serve_forever, daemon=True).start()
external = f"http://127.0.0.1:{receiver.server_port}"

def pdf_bytes():
    stream = b"BT /F1 18 Tf 30 100 Td (Everything View PDF) Tj ET"
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>", b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"]
    result = b"%PDF-1.4\n"
    offsets = [0]
    for index, item in enumerate(objects, 1):
        offsets.append(len(result))
        result += f"{index} 0 obj\n".encode() + item + b"\nendobj\n"
    xref = len(result)
    result += b"xref\n0 6\n0000000000 65535 f \n"
    result += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:])
    return result + f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()

with tempfile.TemporaryDirectory(prefix="ev-browser-") as temp:
    home = Path(temp)
    folder = home / "workspace"
    folder.mkdir()
    (folder / "nested").mkdir()
    (folder / "nested" / "child.txt").write_text("child file")
    (folder / "local.css").write_text(f'body{{color:rgb(10,20,30)}} @import "{external}/css-import"; .x{{background:url({external}/css-image)}}')
    (folder / "pixel.png").write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="))
    (folder / "readme.md").write_text(f'# Safe Markdown\n\n![Local](pixel.png)\n\n![Outside]({external}/markdown)\n\n<script>parent.pwned=true</script>\n')
    (folder / "page.html").write_text(f'''<link rel="stylesheet" href="local.css"><h1>Isolated HTML</h1><img src="pixel.png"><img src="{external}/image"><iframe src="{external}/frame"></iframe><script>fetch('{external}/script');parent.pwned=true</script><form action="{external}/form"><input><button>Submit</button></form><style>.y{{background:u\\72l({external}/escaped)}} @font-face{{font-family:x;src:url({external}/font)}}</style><a href="{external}/navigate">Disabled link</a>''')
    (folder / "doc.pdf").write_bytes(pdf_bytes())
    (folder / "node_modules").mkdir()
    (folder / "node_modules" / "hidden-search.txt").write_text("excluded")
    (folder / "test.txt").write_text("before\n")
    def git(*args):
        return subprocess.check_output(["git", "-C", str(folder), *args], stderr=subprocess.DEVNULL)
    git("init", "-q")
    git("-c", "user.name=EV", "-c", "user.email=ev@example.test", "add", ".")
    git("-c", "user.name=EV", "-c", "user.email=ev@example.test", "commit", "-qm", "base")
    (folder / "test.txt").write_text("staged\n")
    git("add", "test.txt")
    (folder / "test.txt").write_text("unstaged\n")
    index_before = (folder / ".git" / "index").read_bytes()
    env = {**os.environ, "HOME": str(home), "EV_NO_OPEN": "1"}
    process = subprocess.Popen(["node", str(ROOT / "dist" / "cli.mjs"), str(folder)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        first = process.stdout.readline()
        url = re.search(r"http://localhost:\d+", first).group(0)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(**({"executable_path": os.environ["CHROMIUM_PATH"]} if "CHROMIUM_PATH" in os.environ else {"executable_path": "/usr/bin/chromium"} if Path("/usr/bin/chromium").exists() else {}), headless=True, args=["--no-sandbox"])
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url)
            expect(page.locator("#folder-name")).to_have_text("workspace")
            expect(page.locator("#tree")).to_contain_text("node_modules")
            expect(page.locator("#tree")).to_contain_text(".git")
            def choose(name):
                page.locator("#tree .tree-entry").filter(has=page.locator("span", has_text=re.compile(f"^{re.escape(name)}$"))).click()
            choose("page.html")
            frame = page.frame_locator("iframe.document-preview")
            expect(frame.locator("h1")).to_have_text("Isolated HTML")
            expect(frame.locator("img").first).to_have_attribute("src", re.compile("^data:image/png;base64,"))
            assert frame.locator("body").evaluate("node => getComputedStyle(node).color") == "rgb(10, 20, 30)", f"Local CSS missing: {frame.locator('body').inner_html()} / {page.locator('iframe.document-preview').get_attribute('srcdoc')}"
            expect(frame.locator("script,iframe,form")).to_have_count(0)
            assert frame.locator("a").get_attribute("href") is None
            assert page.evaluate("window.pwned") is None
            assert frame.locator("body").evaluate("node => { try { return parent.document.body ? 'read' : 'empty'; } catch { return 'blocked'; } }") == "blocked", "Opaque preview could access parent DOM"
            assert frame.locator("body").evaluate("(node, origin) => fetch(origin + '/api', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({op:'state'})}).then(response => response.status).catch(() => 'blocked')", url) == "blocked", "Preview could call the app API"
            choose("readme.md")
            expect(page.frame_locator("iframe.document-preview").locator("h1")).to_have_text("Safe Markdown")
            choose("pixel.png")
            expect(page.locator(".image-preview img")).to_be_visible()
            choose("doc.pdf")
            expect(page.locator(".pdf-preview canvas")).to_be_visible(timeout=15000)
            expect(page.locator(".pdf-preview")).to_contain_text("1 / 1 ページ")
            choose("test.txt")
            page.get_by_role("button", name="差分", exact=True).click()
            expect(page.locator(".diff-side").first).to_contain_text("staged")
            expect(page.locator(".diff-side").last).to_contain_text("unstaged")
            page.locator("#stage").select_option("staged")
            expect(page.locator(".diff-side").first).to_contain_text("before")
            expect(page.locator(".diff-side").last).to_contain_text("staged")
            page.screenshot(path="/tmp/everything-view-browser.png")
            (folder / "new-file.txt").write_text("new")
            page.get_by_role("button", name="↻ 更新").click()
            expect(page.locator("#tree")).to_contain_text("new-file.txt")
            folder_button = page.locator("#tree .tree-entry").filter(has=page.locator("span", has_text=re.compile("^nested$")))
            folder_button.dblclick()
            child_button = page.locator("#tree .tree-entry").filter(has=page.locator("span", has_text=re.compile("^child.txt$")))
            expect(child_button).to_have_count(1)
            if folder_button.get_attribute("aria-expanded") != "true":
                folder_button.click()
            expect(child_button).to_be_visible()
            page.locator("#tree .tree-entry").filter(has=page.locator("span", has_text=re.compile("^nested$"))).click(button="right")
            page.get_by_role("menuitem", name="ここをトップにして表示").click()
            expect(page.locator("#folder-name")).to_have_text("nested")
            page.locator("#folder-name").click(button="right")
            page.keyboard.press("Escape")
            expect(page.locator("#context-menu")).to_be_hidden()
            page.locator("#folder-name").click(button="right")
            page.get_by_role("menuitem", name="親を一段表示").click()
            expect(page.locator("#folder-name")).to_have_text("workspace")
            page.locator("#query").fill("hidden-search")
            page.get_by_role("button", name="HOMEを検索").click()
            expect(page.locator("#status")).to_contain_text("0件（HOME）")
            page.locator("#query").fill("child.txt")
            page.get_by_role("button", name="HOMEを検索").click()
            expect(page.locator("#results .result")).to_have_count(1)
            page.locator("#results .result").click()
            expect(page.locator("#folder-name")).to_have_text("nested")
            expect(page.locator("#content")).to_contain_text("child file")
            time.sleep(0.25)
            assert not requests, f"Preview leaked external traffic: {requests}"
            assert not errors, f"Browser errors: {errors}"
            assert (folder / ".git" / "index").read_bytes() == index_before
            browser.close()
        print("PASS: real Chromium previews, no external traffic, PDF worker, diffs, tree, refresh, search, context menus, unchanged index")
    finally:
        process.send_signal(signal.SIGINT)
        process.wait(timeout=10)
        receiver.shutdown()
