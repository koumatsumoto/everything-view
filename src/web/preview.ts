import DOMPurify from "dompurify";
import { marked } from "marked";
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api } from "./api";
GlobalWorkerOptions.workerSrc = pdfWorker;
let activePdf: PDFDocumentLoadingTask | null = null;
let previewEpoch = 0;
export function disposePreview() {
  previewEpoch++;
  if (activePdf) {
    void activePdf.destroy().catch(() => {});
    activePdf = null;
  }
}
export interface Content {
  mime: string;
  binary: boolean;
  text: string;
  data: string;
}
interface Resource {
  id: string;
  mime: string;
  data: string;
  text: string;
}
const bytes = (data: string) => Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
function safeDeclaration(style: CSSStyleDeclaration): string {
  const clean = document.createElement("span").style;
  for (const property of style) {
    const value = style.getPropertyValue(property);
    // CSS is presentation only. No URL, imports, escaped function names, custom
    // variables, fonts, or other resource-producing values survive this allowlist.
    if (
      property.startsWith("--") ||
      /url|image|src|attr|var\s*\(|env\s*\(|\\|@/iu.test(value) ||
      /behavior|binding/iu.test(property)
    )
      continue;
    clean.setProperty(property, value, style.getPropertyPriority(property));
  }
  return clean.cssText;
}
export function safeCss(css: string): string {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    function rules(input: CSSRuleList): string {
      let result = "";
      for (const rule of input) {
        if (rule instanceof CSSStyleRule)
          result += `${rule.selectorText}{${safeDeclaration(rule.style)}}`;
        else if (rule instanceof CSSMediaRule)
          result += `@media ${rule.conditionText}{${rules(rule.cssRules)}}`;
      }
      return result;
    }
    return rules(sheet.cssRules);
  } catch {
    return "";
  }
}
async function isolatedMarkup(html: string, id: string): Promise<HTMLIFrameElement> {
  const clean = DOMPurify.sanitize(html, {
    ADD_TAGS: ["link"],
    ADD_ATTR: ["rel"],
    FORBID_TAGS: [
      "script",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "meta",
      "base",
      "svg",
      "math",
      "video",
      "audio",
      "source",
    ],
    FORBID_ATTR: ["srcset", "formaction", "action", "ping", "target", "download", "autofocus"],
    ALLOW_DATA_ATTR: false,
  });
  const doc = new DOMParser().parseFromString(clean, "text/html");
  const resource = (reference: string) => api<Resource>("resource", { id, reference });
  let budget = 0;
  for (const image of doc.querySelectorAll("img")) {
    const reference = image.getAttribute("src");
    image.removeAttribute("src");
    if (!reference) continue;
    try {
      if (budget++ >= 40) throw new Error("Resource limit");
      const asset = await resource(reference);
      if (!asset.mime.startsWith("image/")) continue;
      image.src = `data:${asset.mime};base64,${asset.data}`;
    } catch {
      image.alt = `${image.alt || "画像"} (読み込み拒否・表示範囲外)`;
    }
  }
  for (const link of doc.querySelectorAll("link")) {
    const reference = link.getAttribute("href");
    if (link.getAttribute("rel")?.toLowerCase() === "stylesheet" && reference && budget++ < 40) {
      try {
        const asset = await resource(reference);
        if (asset.mime === "text/css") {
          const style = doc.createElement("style");
          style.textContent = safeCss(asset.text).replaceAll("<", "\\3c ");
          link.after(style);
        }
      } catch {
        /* Out-of-scope and external stylesheets are blocked. */
      }
    }
    link.remove();
  }
  for (const style of doc.querySelectorAll("style"))
    style.textContent = safeCss(style.textContent ?? "").replaceAll("<", "\\3c ");
  for (const node of doc.querySelectorAll<HTMLElement>("[style]"))
    node.setAttribute("style", safeDeclaration(node.style));
  for (const node of doc.querySelectorAll("*")) {
    for (const attribute of Array.from(node.attributes)) {
      if (
        ["href", "xlink:href", "poster", "background", "cite"].includes(attribute.name) ||
        attribute.name.startsWith("on")
      )
        node.removeAttribute(attribute.name);
      if (attribute.name === "src" && node.tagName !== "IMG") node.removeAttribute(attribute.name);
    }
  }
  const iframe = document.createElement("iframe");
  iframe.title = "隔離プレビュー";
  iframe.className = "document-preview";
  iframe.setAttribute("sandbox", "");
  iframe.referrerPolicy = "no-referrer";
  // Opaque origin, no scripts or navigation, and only data: raster images.
  const csp =
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; navigate-to 'none'";
  const styles = Array.from(doc.querySelectorAll("style"))
    .map((style) => {
      const value = style.outerHTML;
      style.remove();
      return value;
    })
    .join("");
  iframe.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>body{font:16px/1.65 system-ui,sans-serif;color:#252d33;padding:24px;overflow-wrap:anywhere}img{max-width:100%}pre{overflow:auto;padding:16px;background:#f2f4f5}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 12px}</style>${styles}</head><body>${doc.body.innerHTML}</body></html>`;
  return iframe;
}
export async function renderPreview(content: Content, id: string): Promise<HTMLElement> {
  if (content.binary) {
    const message = document.createElement("p");
    message.className = "message";
    message.textContent = "このバイナリ形式は表示できません。";
    return message;
  }
  if (content.mime === "text/html") return isolatedMarkup(content.text, id);
  if (content.mime === "text/markdown")
    return isolatedMarkup(await marked.parse(content.text, { gfm: true }), id);
  if (content.mime.startsWith("image/") && content.mime !== "image/svg+xml") {
    const wrapper = document.createElement("div");
    wrapper.className = "image-preview";
    const image = document.createElement("img");
    image.alt = "選択した画像";
    image.src = `data:${content.mime};base64,${content.data}`;
    wrapper.append(image);
    return wrapper;
  }
  if (content.mime === "application/pdf") {
    const epoch = previewEpoch;
    const wrapper = document.createElement("div");
    wrapper.className = "pdf-preview";
    const loadingTask = getDocument({
      data: bytes(content.data),
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: true,
      useWorkerFetch: false,
      stopAtErrors: true,
    });
    activePdf = loadingTask;
    const pdf = await loadingTask.promise;
    if (epoch !== previewEpoch) {
      await loadingTask.destroy();
      throw new Error("Preview cancelled.");
    }
    let pageNumber = 1;
    const controls = window.document.createElement("div"),
      canvas = window.document.createElement("canvas");
    const previous = window.document.createElement("button"),
      next = window.document.createElement("button"),
      label = window.document.createElement("span");
    previous.textContent = "← 前のページ";
    next.textContent = "次のページ →";
    controls.append(previous, label, next);
    wrapper.append(controls, canvas);
    let drawing = false;
    const draw = async () => {
      if (drawing) return;
      drawing = true;
      previous.disabled = next.disabled = true;
      try {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.25 });
        if (viewport.width * viewport.height > 16000000)
          throw new Error("このPDFページは大きすぎるため表示できません。");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvas, viewport }).promise;
        label.textContent = `${pageNumber} / ${pdf.numPages} ページ`;
      } finally {
        drawing = false;
        previous.disabled = pageNumber <= 1;
        next.disabled = pageNumber >= pdf.numPages;
      }
    };
    const move = async (delta: number) => {
      if (drawing) return;
      pageNumber += delta;
      try {
        await draw();
      } catch {
        label.textContent = "このPDFページを表示できませんでした。";
      }
    };
    previous.onclick = () => {
      void move(-1);
    };
    next.onclick = () => {
      void move(1);
    };
    await draw();
    // No annotations, actions, links, JavaScript, XFA, attachments, or document URLs are rendered.
    return wrapper;
  }
  const pre = document.createElement("pre");
  pre.className = "code";
  pre.textContent =
    content.mime === "image/svg+xml"
      ? "SVGは安全のためソースだけを表示します。\n\n" +
        new TextDecoder().decode(bytes(content.data))
      : content.text;
  return pre;
}
