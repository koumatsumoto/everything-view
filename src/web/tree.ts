import { api, element, type Entry, type State } from "./api";
export function createTree(
  select: (entry: Entry) => void,
  navigate: (op: string, id?: string) => Promise<void>,
) {
  const tree = element("tree");
  const context = element("context-menu");
  const close = () => {
    context.hidden = true;
    context.replaceChildren();
  };
  document.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  function menu(event: MouseEvent, entry: Entry, root = false) {
    event.preventDefault();
    close();
    if (!entry.directory) return;
    const actions = root ? [["親を一段表示", "parent"]] : [["ここをトップにして表示", "top"]];
    for (const [label, op] of actions) {
      const button = document.createElement("button");
      button.textContent = label;
      button.setAttribute("role", "menuitem");
      button.onclick = () => {
        close();
        void navigate(op, entry.id);
      };
      context.append(button);
    }
    context.style.left = `${Math.min(event.clientX, window.innerWidth - 240)}px`;
    context.style.top = `${Math.min(event.clientY, window.innerHeight - 70)}px`;
    context.hidden = false;
  }
  async function children(id: string, container: HTMLElement) {
    const { entries } = await api<{ entries: Entry[] }>("list", { id });
    for (const entry of entries) {
      const group = document.createElement("div");
      group.className = "tree-group";
      const button = document.createElement("button");
      button.className = `tree-entry${entry.changed ? " changed" : ""}${entry.deleted ? " deleted" : ""}`;
      button.title = [
        entry.name,
        entry.deleted ? "削除済み" : "",
        entry.symlink ? "シンボリックリンク" : "",
        entry.changed ? "Gitの変更あり" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const marker = document.createElement("span");
      marker.className = "file-marker";
      marker.textContent = entry.directory ? "▸" : entry.symlink ? "↗" : "·";
      const name = document.createElement("span");
      name.textContent = entry.name;
      button.append(marker, name);
      if (entry.changed) {
        const dot = document.createElement("span");
        dot.className = "change-dot";
        dot.textContent = "●";
        button.append(dot);
      }
      group.append(button);
      container.append(group);
      let loaded = false,
        expanded = false;
      const nested = document.createElement("div");
      nested.className = "tree-children";
      nested.hidden = true;
      group.append(nested);
      button.onclick = async () => {
        try {
          if (entry.directory) {
            if (!loaded) {
              await children(entry.id, nested);
              loaded = true;
            }
            expanded = !expanded;
            nested.hidden = !expanded;
            marker.textContent = expanded ? "▾" : "▸";
            button.setAttribute("aria-expanded", String(expanded));
          } else {
            tree.querySelector(".selected")?.classList.remove("selected");
            button.classList.add("selected");
            select(entry);
          }
        } catch (error) {
          container.dispatchEvent(new CustomEvent("tree-error", { bubbles: true, detail: error }));
        }
      };
      button.oncontextmenu = (event) => menu(event, entry);
    }
    if (!entries.length) {
      const empty = document.createElement("small");
      empty.className = "muted";
      empty.textContent = "空のフォルダ";
      container.append(empty);
    }
  }
  return async (state: State) => {
    close();
    tree.replaceChildren();
    element("folder-name").textContent = state.root?.name ?? "ファイルをすぐに確認。";
    element("location").textContent = state.root?.displayPath ?? "HOMEを検索して始めてください。";
    element("repo").textContent = state.root
      ? (state.gitMessage ??
        (state.repository ? `Git · ${state.repository}   ● 変更あり` : "Git管理外"))
      : "";
    element<HTMLButtonElement>("parent").disabled = !state.root?.canParent;
    element("folder-name").oncontextmenu = state.root
      ? (event) =>
          menu(
            event,
            { ...state.root!, directory: true, deleted: false, symlink: false, changed: false },
            true,
          )
      : null;
    if (state.root) await children(state.root.id, tree);
  };
}
