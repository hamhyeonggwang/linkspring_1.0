import { app, BrowserWindow, dialog, ipcMain, protocol, session } from "electron";
import { join, resolve, sep, extname } from "node:path";
import { readFile } from "node:fs/promises";
import { mkdirSync, rmSync } from "node:fs";
import { z } from "zod";
import { LocalDatabase } from "./database";
import { seedDemo } from "./demo";
import { AISettingsStore } from "./ai-settings";
import { readState } from "../lib/state-store";
import { executeAction } from "../lib/state-actions";
import { analyzeSchedule, assistCandidates, assistNotice, testAIConnection } from "../lib/ai-assistant";
import { AIError } from "../lib/ai-provider";
import { scheduleTokens, today } from "../lib/domain";
import { AppError } from "../lib/errors";
import { operations, type Operation } from "../shared/desktop";

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName("LinkSpring");
const smokeDir = !app.isPackaged ? process.env.LINKSPRING_SMOKE_DIR : undefined;
const profile = smokeDir || (process.platform === "win32" ? join(process.env.LOCALAPPDATA || app.getPath("appData"), "LinkSpring") : join(app.getPath("appData"), "LinkSpring"));
mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
const migrations = join(__dirname, "migrations");
let window: BrowserWindow;
let db: LocalDatabase;
let workspace: "work" | "demo" = "work";
let chain: Promise<unknown> = Promise.resolve();
const pathFor = (mode: string) => join(profile, "data", mode === "work" ? "linkspring.sqlite" : "demo.sqlite");
const info = () => ({ workspace, path: db.path, version: app.getVersion() });

async function run() {
  db = new LocalDatabase(pathFor(workspace), migrations);
  const settings = new AISettingsStore(join(profile, "ai-settings.json"));
  const renderer = resolve(__dirname, "renderer");
  protocol.handle("app", async request => {
    const url = new URL(request.url);
    const file = resolve(renderer, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`);
    if (url.host !== "linkspring" || !file.startsWith(renderer + sep)) return new Response("Forbidden", { status: 403 });
    try {
      const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".csv": "text/csv; charset=utf-8" };
      return new Response(await readFile(file), { headers: { "content-type": types[extname(file)] || "application/octet-stream" } });
    } catch { return new Response("Not found", { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const u = new URL(details.url);
    callback({ cancel: !(u.protocol === "app:" && u.hostname === "linkspring") });
  });
  window = new BrowserWindow({
    width: 1360, height: 900, minWidth: 1000, minHeight: 680, show: !smokeDir,
    title: "이어:봄 LinkSpring", autoHideMenuBar: true, backgroundColor: "#e9eef5",
    webPreferences: { preload: join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  ipcMain.handle("linkspring:request", (event, operation: Operation, payload: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !event.senderFrame?.url.startsWith("app://linkspring/") || !operations.includes(operation)) return { ok: false, error: "허용되지 않은 요청입니다." };
    const task = chain.then(async () => {
      try {
        if (JSON.stringify(payload ?? null).length > 3_000_000) throw new AppError(400, "한 번에 처리할 수 있는 크기를 초과했습니다.");
        return { ok: true, data: await dispatch(operation, payload) };
      } catch (error) {
        // Never return raw SQLite errors, SQL, file content, or credentials.
        return { ok: false, error: error instanceof AppError || error instanceof AIError ? error.message : "처리하지 못했습니다. 입력과 백업 파일을 확인해 주세요. 현재 데이터는 자동으로 삭제되지 않습니다." };
      }
    });
    chain = task.catch(() => undefined);
    return task;
  });
  async function dispatch(operation: Operation, payload: unknown): Promise<unknown> {
    switch (operation) {
      case "state": return readState(db);
      case "info": return info();
      case "mutate": await executeAction(payload, db, workspace === "demo" ? "체험 담당자" : "로컬 담당자"); return { ok: true };
      case "settings": return settings.info();
      case "saveSettings":
        try { return settings.save(payload); } catch (e) { throw new AppError(400, e instanceof Error ? e.message : "설정 저장 실패"); }
      case "analyze": {
        const parsed = z.object({ text: z.string().max(4000) }).safeParse(payload);
        if (!parsed.success) throw new AppError(400, "일정 정보를 확인하세요.");
        return analyzeSchedule(scheduleTokens(parsed.data.text), today(), settings.config());
      }
      case "testAI": return testAIConnection(settings.config());
      case "aiAssist": {
        const parsed = z.object({ kind: z.enum(["candidates", "notice"]), slotId: z.string().max(100), version: z.string().uuid() }).safeParse(payload);
        if (!parsed.success) throw new AppError(400, "AI 요청을 확인하세요.");
        const state = await readState(db);
        if (state.settings.state_revision !== parsed.data.version) throw new AppError(409, "데이터가 변경되었습니다. 새로고침 후 다시 분석하세요.");
        return parsed.data.kind === "candidates" ? assistCandidates(state, parsed.data.slotId, settings.config()) : assistNotice(state, parsed.data.slotId, settings.config());
      }
      case "workspace": {
        const mode = z.enum(["work", "demo"]).parse(payload);
        if (workspace !== mode) {
          const next = new LocalDatabase(pathFor(mode), migrations);
          try { if (mode === "demo") await seedDemo(next); } catch (e) { next.close(); throw e; }
          db.close(); db = next; workspace = mode;
        }
        return info();
      }
      case "demoReset": {
        if (workspace !== "demo") throw new AppError(400, "예시 체험에서만 초기화할 수 있습니다.");
        const answer = await dialog.showMessageBox(window, { type: "question", buttons: ["취소", "체험 초기화"], defaultId: 0, cancelId: 0, message: "체험 데이터의 모든 변경을 지우고 새 예시를 만듭니다.", detail: "실제 업무 데이터는 유지됩니다." });
        if (answer.response !== 1) return { canceled: true };
        db.close(); rmSync(pathFor("demo")); db = new LocalDatabase(pathFor("demo"), migrations); await seedDemo(db); return info();
      }
      case "backup": {
        const selected = await dialog.showSaveDialog(window, { title: "현재 데이터 백업 저장", defaultPath: `LinkSpring-${workspace}-${today()}.sqlite`, filters: [{ name: "이어:봄 백업", extensions: ["sqlite"] }] });
        if (selected.canceled || !selected.filePath) return { canceled: true };
        db.backup(selected.filePath); return { path: selected.filePath };
      }
      case "restore": {
        const selected = await dialog.showOpenDialog(window, { title: "복원할 이어:봄 백업 선택", properties: ["openFile"], filters: [{ name: "이어:봄 백업", extensions: ["sqlite"] }] });
        if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
        const answer = await dialog.showMessageBox(window, { type: "warning", buttons: ["취소", "복원"], defaultId: 0, cancelId: 0, message: `${workspace === "demo" ? "체험" : "실제 업무"} 데이터를 선택한 백업으로 교체할까요?`, detail: "현재 데이터는 같은 데이터 폴더에 자동 백업한 뒤 복원합니다. 다른 PC의 Claude API 키는 복원되지 않습니다." });
        if (answer.response !== 1) return { canceled: true };
        return { safetyBackup: db.restore(selected.filePaths[0]) };
      }
    }
  }
  await window.loadURL("app://linkspring/");
  if (smokeDir) {
    const { runSmoke } = await import("./smoke");
    await runSmoke(window, smokeDir, process.env.LINKSPRING_LIVE_AI === "1" && process.env.ANTHROPIC_API_KEY ? () => {
      settings.save({ provider: "anthropic", endpoint: "", model: process.env.LINKSPRING_TEST_MODEL, enabled: true, apiKey: process.env.ANTHROPIC_API_KEY });
    } : undefined);
    app.quit();
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(run).catch(error => {
    if (smokeDir) { console.error(error); app.exit(1); }
    else { dialog.showErrorBox("이어:봄을 시작하지 못했습니다", "데이터를 지우거나 초기화하지 마세요. 저장 공간과 파일 접근 권한을 확인한 후 다시 실행해 주세요."); app.quit(); }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => { db?.close(); });
}
