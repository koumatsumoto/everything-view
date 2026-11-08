import "./styles.css";
import { api, element, notify, type Entry, type State } from "./api";
import { createTree } from "./tree";
import { renderPreview, disposePreview, type Content } from "./preview";
import { renderDiff } from "./diff";
type Mode = "preview" | "code" | "diff";
let selected: Pick<Entry, "id" | "name"> | null = null,
  mode: Mode = "preview",
  generation = 0,
  busy = false,
  preferDiff = false;
const content = element("content");
function message(text: string) {
  const p = document.createElement("p");
  p.className = "message";
  p.textContent = text;
  content.replaceChildren(p);
}
async function show() {
  const current = ++generation;
  disposePreview();
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
    button.classList.toggle("active", button.dataset.mode === mode);
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }
  element("diff-options").hidden = mode !== "diff";
  element("external").hidden = true;
  if (!selected) {
    return;
  }
  element("file-name").textContent = selected.name;
  message("読み込み中…");
  try {
    let view: HTMLElement;
    if (mode === "diff") {
      const result = await api<{
        before: string;
        after: string;
        binary: boolean;
        message?: string;
      }>("diff", { id: selected.id, stage: element<HTMLSelectElement>("stage").value });
      if (current !== generation) return;
      if (result.message) {
        message(result.message);
        return;
      }
      view = renderDiff(result.before, result.after);
    } else {
      const file = await api<Content>("read", { id: selected.id });
      if (current !== generation) return;
      element("external").hidden = file.mime !== "text/html";
      if (mode === "code") {
        view = document.createElement("pre");
        view.className = "code";
        view.textContent =
          file.binary || file.data ? "この画像・バイナリのソースは表示できません。" : file.text;
      } else view = await renderPreview(file, selected.id);
    }
    if (current === generation) content.replaceChildren(view);
  } catch (error) {
    if (current === generation)
      message(`${(error as Error).message} 削除済みファイルは差分を選んでください。`);
  }
}
const tree = createTree((entry) => {
  selected = entry;
  mode = preferDiff ? "diff" : "preview";
  void show();
}, navigate);
async function apply(state: State) {
  generation++;
  disposePreview();
  selected = state.selected;
  await tree(state);
  if (selected) await show();
  else {
    element("file-name").textContent = "Everything View";
    message("左のツリーからファイルを選んでください。フォルダを右クリックするとトップにできます。");
  }
}
async function navigate(op: string, id?: string) {
  if (busy) return;
  busy = true;
  notify("");
  try {
    const state = await api<State>(op, { id });
    await apply(state);
  } catch (error) {
    notify((error as Error).message);
  } finally {
    busy = false;
  }
}
element("parent").onclick = () => {
  void navigate("parent");
};
element("refresh").onclick = async () => {
  if (busy) return;
  busy = true;
  try {
    const state = await api<State>("refresh");
    await apply(state);
    notify("ディスクから再取得しました。");
  } catch (error) {
    notify((error as Error).message);
  } finally {
    busy = false;
  }
};
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mode]"))
  button.onclick = () => {
    mode = button.dataset.mode as Mode;
    void show();
  };
element("stage").onchange = () => {
  void show();
};
element("external").onclick = async () => {
  if (!selected || busy) return;
  busy = true;
  try {
    await api("external", { id: selected.id });
    notify("外部ブラウザで開きました。ファイル内のスクリプトが実行される場合があります。");
  } catch (error) {
    notify((error as Error).message);
  } finally {
    busy = false;
  }
};
element("search-form").onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  const results = element("results");
  results.replaceChildren();
  notify("HOMEを検索中…");
  try {
    const result = await api<{
      results: { id: string; name: string; displayPath: string; directory: boolean }[];
      truncated: boolean;
    }>("search", { query: element<HTMLInputElement>("query").value });
    for (const item of result.results) {
      const button = document.createElement("button");
      button.className = "result";
      button.textContent = `${item.directory ? "▸" : "·"} ${item.displayPath}`;
      button.onclick = () => {
        results.replaceChildren();
        void navigate("openSearch", item.id);
      };
      results.append(button);
    }
    notify(
      result.truncated
        ? "検索の上限に達しました。名前やパスを絞り込んでください。"
        : `${result.results.length}件（HOME）。検索は2文字以上で入力してください。`,
    );
  } catch (error) {
    notify((error as Error).message);
  } finally {
    busy = false;
  }
};
element("tree").addEventListener("tree-error", (event) =>
  notify(((event as CustomEvent).detail as Error).message),
);
async function initialize() {
  try {
    const state = await api<State>("state");
    preferDiff = state.diffMode;
    mode = preferDiff ? "diff" : "preview";
    await apply(state);
    if (!state.root) element<HTMLInputElement>("query").focus();
  } catch (error) {
    notify((error as Error).message);
  }
}
void initialize();
