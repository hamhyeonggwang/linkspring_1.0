import type { BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInstitutionSmoke } from "./institution-smoke";
import { captureSubmission } from "./submission-screens";
export async function runSmoke(window: BrowserWindow, output: string, prepareAI?: () => void) {
  // Test hook runs only from an unpackaged development build in an isolated profile.
  const result = await window.webContents.executeJavaScript(`(async () => {
    if (!window.linkspring || typeof require !== 'undefined') throw new Error('Renderer isolation failed');
    const call = (op, data) => window.linkspring.call(op, data);
    const empty = await call('state');
    await call('workspace', 'demo');
    let state = await call('state');
    if (state.participants.length !== 12 || state.slots.length !== 2) throw new Error('Demo seed failed');
    const slot = state.slots[0];
    const person = state.participants.find(p => p.type === slot.type);
    await call('mutate', {kind:'confirm', version:state.settings.state_revision, slotId:slot.id, participantId:person.id});
    state = await call('state');
    if (state.slots.find(s => s.id === slot.id).status !== '연결 완료') throw new Error('Confirm failed');
    await call('mutate', {kind:'notice', version:state.settings.state_revision, slotId:slot.id});
    state = await call('state');
    if (state.slots.find(s => s.id === slot.id).noticeStatus !== '안내 완료') throw new Error('Notice failed');
    await call('workspace', 'work');
    const work = await call('state');
    if (work.participants.length !== empty.participants.length) throw new Error('Work/demo isolation failed');
    const parsed = await call('analyze', {text:'내일 오전 9시 작업치료 OT-01'});
    if (parsed.source !== 'rules') throw new Error('Offline analysis failed');
    let rejected = false;
    try { await call('arbitrarySQL', 'DELETE FROM participants'); } catch { rejected = true; }
    if (!rejected) throw new Error('IPC allowlist failed');
    return { isolation:true, demo:true, confirmation:true, notice:true, workspaceIsolation:true, offlineAnalysis:true, ipcAllowlist:true, text:document.body.innerText.slice(0,2000) };
  })()`);
  try {
    result.institutionUI = await runInstitutionSmoke(window);
  } catch (error) {
    writeFileSync(join(output, "failure.png"), (await window.webContents.capturePage()).toPNG());
    writeFileSync(join(output, "failure.txt"), await window.webContents.executeJavaScript("document.body.innerText"));
    throw error;
  }
  writeFileSync(
    join(output, "smoke-result.json"),
    JSON.stringify(result, null, 2),
  );
  // Let Chromium paint the committed React frame before capturing it.
  await new Promise(resolve => setTimeout(resolve, 300));
  const pages = [
    ["queue", "처리 대기"],
    ["children", "대기자 관리"],
    ["schedule", "치료 일정"],
    ["review", "추가 확인 필요"],
    ["history", "연결·안내 내역"],
  ] as const;
  for (const [name, label] of pages) {
    await window.webContents.executeJavaScript(`(async () => {
      const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === ${JSON.stringify(label)});
      if (!button) throw new Error('Screenshot navigation failed: ' + ${JSON.stringify(label)});
      button.click();
      await new Promise(resolve => setTimeout(resolve, 350));
    })()`);
    writeFileSync(join(output, `page-${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  writeFileSync(
    join(output, "screen.png"),
    (await window.webContents.capturePage()).toPNG(),
  );
  console.log("DESKTOP_SMOKE_OK", JSON.stringify(result));
  if (process.env.LINKSPRING_SUBMISSION_SCREENSHOTS === "1") {
    prepareAI?.();
    try { await captureSubmission(window, output, !!prepareAI); }
    catch (e) { writeFileSync(join(output, "ai-failure.png"), (await window.webContents.capturePage()).toPNG()); throw e; }
  }
}
