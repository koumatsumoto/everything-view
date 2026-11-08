export const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const session = document.querySelector<HTMLMetaElement>('meta[name="ev-session"]')!.content;
export async function api<T>(op: string, data: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch("/api", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-EV-Session": session },
    body: JSON.stringify({ op, ...data }),
    credentials: "same-origin",
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "読み込みに失敗しました。");
  return result as T;
}
export interface State {
  root: { id: string; name: string; displayPath: string; canParent: boolean } | null;
  selected: { id: string; name: string } | null;
  repository: string | null;
  diffMode: boolean;
}
export interface Entry {
  id: string;
  name: string;
  directory: boolean;
  deleted: boolean;
  symlink: boolean;
  changed: boolean;
}
export function notify(message: string) {
  element("status").textContent = message;
}
