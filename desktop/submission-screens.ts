import type { BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function captureSubmission(window: BrowserWindow, output: string, live: boolean) {
  await window.webContents.executeJavaScript(`(async () => {
    const call = (op, data) => window.linkspring.call(op, data);
    document.querySelector('.desktop-settings').open = true;
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '예시로 체험').click();
    await new Promise(r => setTimeout(r, 600));
    let s = await call('state');
    const existing = s.slots.find(x => x.status !== '연결 완료');
    const entry = {id:existing.date+'|OT-01|10:00',date:existing.date,weekday:'',department:'작업치료',therapistId:'OT-01',therapistName:'OT-01',startTime:'10:00',endTime:'10:30',treatmentCode:'DEMO-REVIEW',importBatch:'demo'};
    await call('mutate',{kind:'schedule_import',version:s.settings.state_revision,date:entry.date,entries:[...s.scheduleEntries,entry]});
    s = await call('state');
    await call('mutate',{kind:'create',version:s.settings.state_revision,slot:{date:entry.date,startTime:entry.startTime,endTime:entry.endTime,type:entry.department,therapist:entry.therapistId}});
    s = await call('state');
    const hold = s.slots.find(x=>x.startTime==='10:00');
    await call('mutate',{kind:'hold',version:s.settings.state_revision,slotId:hold.id});
    [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='새로고침').click();
    await new Promise(r=>setTimeout(r,500));
    document.querySelector('.desktop-message button')?.click();
  })()`);
  const click = async (label: string) => window.webContents.executeJavaScript(`(async()=>{
    const end=Date.now()+30000; let b;
    while(!(b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled))){if(Date.now()>end)throw new Error('Missing button '+${JSON.stringify(label)});await new Promise(r=>setTimeout(r,60));}
    b.click();await new Promise(r=>setTimeout(r,400));
  })()`);
  const capture = async (name: string) => {
    await new Promise(r => setTimeout(r, 4500));
    writeFileSync(join(output, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  const pages = [["queue", "처리 대기"], ["children", "대기자 관리"], ["schedule", "치료 일정"], ["review", "추가 확인 필요"], ["history", "연결·안내 내역"]];
  await new Promise(r => setTimeout(r, 4500));
  for (const [name, label] of pages) { await click(label); await capture(`page-${name}`); }
  await click("처리 대기");
  await window.webContents.executeJavaScript(`document.querySelector('.queue-card').click()`);
  await click("AI 후보 비교 실행");
  await window.webContents.executeJavaScript(`(async()=>{const end=Date.now()+30000;while(!document.querySelector('.ai-result')){if(Date.now()>end)throw new Error('AI result missing');await new Promise(r=>setTimeout(r,100));} ${live ? "if(!document.querySelector('.ai-source.ai'))throw new Error(document.querySelector('.ai-source').textContent);" : ""} })()`);
  await capture("ai-candidates");
  const aiComparison = await window.webContents.executeJavaScript(`document.querySelector('.ai-result').innerText`);
  await window.webContents.executeJavaScript(`document.querySelector('.candidate:not(:disabled)').click();window.confirm=()=>true;void 0;`);
  await click("담당자 확인 후 연결 확정");
  await click("AI 안내문 작성");
  await window.webContents.executeJavaScript(`(async()=>{const end=Date.now()+30000;while(!document.querySelector('[aria-label="AI 안내문 검토"]')){if(Date.now()>end)throw new Error('AI notice missing');await new Promise(r=>setTimeout(r,100));} ${live ? "if(!document.querySelector('.ai-source.ai'))throw new Error(document.querySelector('.ai-source').textContent);" : ""} })()`);
  await window.webContents.executeJavaScript(`document.querySelector('.candidate-dialog').scrollTop=0`);
  await capture("ai-notice");
  const aiNotice = await window.webContents.executeJavaScript(`document.querySelector('.ai-result').innerText`);
  await click("검토한 안내문 저장");
  await window.webContents.executeJavaScript(`(async()=>{await new Promise(r=>setTimeout(r,400));const s=await window.linkspring.call('state');if(!s.audit.some(a=>a.action==='notice_draft'))throw new Error('Notice draft not persisted');})()`);
  await click("실제 안내 완료로 기록");
  await window.webContents.executeJavaScript(`document.querySelector('.candidate-dialog [data-slot="dialog-close"]').click()`);
  await click("결석·빈 회기 등록");
  await window.webContents.executeJavaScript(`(async()=>{
    const s=await window.linkspring.call('state');const date=s.slots[0].date;
    const input=document.querySelector('.absence-dialog textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,date+' 오전 9시 작업치료 OT-01 결석');input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await click("일정 정보만 추출"); await click("내용 확인 후 AI로 분석");
  await window.webContents.executeJavaScript(`(async()=>{const end=Date.now()+30000;while(document.querySelector('.absence-dialog').textContent.includes('분석 중…')){if(Date.now()>end)throw new Error('Analysis timeout');await new Promise(r=>setTimeout(r,100));}})()`);
  const absenceResult = await window.webContents.executeJavaScript(`document.querySelector('.absence-dialog [data-slot="badge"]').textContent`);
  if (live && !absenceResult.startsWith("AI 분석")) throw new Error(`Live absence failed: ${absenceResult}`);
  await capture("ai-absence");
  await window.webContents.executeJavaScript(`document.querySelector('.absence-dialog [data-slot="dialog-close"]').click();document.querySelector('.desktop-settings').open=true;`);
  await click("AI 연결 설정"); await capture("ai-settings");
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="창 닫기"]').click()`);
  const result = { liveAI: live, candidateComparison: true, noticeDraftSaved: true, absenceResult, aiComparison, aiNotice };
  writeFileSync(join(output, "ai-ui-result.json"), JSON.stringify(result, null, 2));
  return result;
}
