export const operations = ["state", "mutate", "analyze", "info", "workspace", "demoReset", "backup", "restore", "settings", "saveSettings"] as const;
export type Operation = typeof operations[number];
export interface DesktopInfo {
  workspace: "work" | "demo";
  path: string;
  version: string;
}
export interface AISettings { model: string; hasKey: boolean; enabled: boolean }
export interface DesktopBridge { call(operation: Operation, payload?: unknown): Promise<unknown> }
declare global { interface Window { linkspring?: DesktopBridge } }
