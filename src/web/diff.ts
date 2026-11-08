import { diffLines } from "diff";
export function renderDiff(before: string, after: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "diff-grid";
  const left = document.createElement("div"),
    right = document.createElement("div");
  left.className = right.className = "diff-side";
  for (const [pane, label] of [
    [left, "変更前"],
    [right, "変更後"],
  ] as const) {
    const heading = document.createElement("strong");
    heading.textContent = label;
    pane.append(heading);
  }
  let oldLine = 1,
    newLine = 1;
  function row(pane: HTMLElement, text: string, number: number | null, kind: string) {
    const line = document.createElement("div");
    line.className = `diff-line ${kind}`;
    const gutter = document.createElement("span");
    gutter.textContent = number === null ? "" : String(number);
    gutter.className = "line-number";
    const code = document.createElement("span");
    code.textContent = text || " ";
    line.append(gutter, code);
    pane.append(line);
  }
  if (before.split("\n").length + after.split("\n").length > 30000) {
    const message = document.createElement("p");
    message.className = "message";
    message.textContent =
      "行数が多すぎます（前後の合計3万行まで）。専用の差分ツールを使ってください。";
    return message;
  }
  const parts = diffLines(before, after, { timeout: 1000, maxEditLength: 10000 });
  if (!parts) {
    const message = document.createElement("p");
    message.className = "message";
    message.textContent =
      "この差分は複雑すぎるため表示できません。専用の差分ツールを使ってください。";
    return message;
  }
  for (const part of parts) {
    const lines = part.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const line of lines) {
      if (part.removed) {
        row(left, line, oldLine++, "removed");
        row(right, "", null, "gap");
      } else if (part.added) {
        row(left, "", null, "gap");
        row(right, line, newLine++, "added");
      } else {
        row(left, line, oldLine++, "");
        row(right, line, newLine++, "");
      }
    }
  }
  if (!before && !after) {
    row(left, "（空）", null, "");
    row(right, "（空）", null, "");
  }
  let syncing = false;
  for (const [source, target] of [
    [left, right],
    [right, left],
  ])
    source.onscroll = () => {
      if (syncing) return;
      syncing = true;
      target.scrollTop = source.scrollTop;
      target.scrollLeft = source.scrollLeft;
      requestAnimationFrame(() => {
        syncing = false;
      });
    };
  wrapper.append(left, right);
  return wrapper;
}
