import type { BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
export async function runSmoke(window: BrowserWindow, output: string) {
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
  writeFileSync(join(output, "smoke-result.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(output, "screen.png"), (await window.webContents.capturePage()).toPNG());
  console.log("DESKTOP_SMOKE_OK", JSON.stringify(result));
}
