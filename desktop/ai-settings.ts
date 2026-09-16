import { safeStorage } from "electron";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { z } from "zod";
const settingsSchema = z.object({ model: z.string().max(120).regex(/^[a-zA-Z0-9._-]*$/), enabled: z.boolean(), apiKey: z.string().max(512).optional(), clearKey: z.boolean().optional() });
type Stored = { model: string; enabled: boolean; key?: string };
export class AISettingsStore {
  constructor(private path: string) {}
  private read(): Stored {
    if (!existsSync(this.path)) return { model: "", enabled: false };
    return JSON.parse(readFileSync(this.path, "utf8")) as Stored;
  }
  info() { const s = this.read(); return { model: s.model, enabled: s.enabled, hasKey: !!s.key }; }
  save(input: unknown) {
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success) throw new Error("Claude 설정을 확인하세요.");
    const { model, enabled, apiKey, clearKey } = parsed.data;
    let key = clearKey ? undefined : this.read().key;
    if (apiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("이 PC에서 보안 키 저장을 사용할 수 없습니다.");
      key = safeStorage.encryptString(apiKey.trim()).toString("base64");
    }
    if (enabled && (!key || !model)) throw new Error("Claude 사용에는 본인의 API 키와 모델 ID가 필요합니다.");
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify({ model, enabled, key }), { mode: 0o600 });
    renameSync(temporary, this.path);
    return this.info();
  }
  config() {
    const s = this.read();
    if (!s.enabled || !s.key || !safeStorage.isEncryptionAvailable()) return {};
    try { return { model: s.model, apiKey: safeStorage.decryptString(Buffer.from(s.key, "base64")) }; }
    catch { return {}; }
  }
}
