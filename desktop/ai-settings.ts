import { safeStorage } from "electron";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { apiEndpoint, settingsInput, type AIConfig, type AIProvider } from "../lib/ai-provider";
type Stored = { provider: AIProvider; endpoint: string; model: string; enabled: boolean; key?: string };
export class AISettingsStore {
  constructor(private path: string) {}
  private read(): Stored {
    const defaults: Stored = { provider: "anthropic", endpoint: "", model: "", enabled: false };
    if (!existsSync(this.path)) return defaults;
    try { return { ...defaults, ...JSON.parse(readFileSync(this.path, "utf8")) }; }
    catch { return defaults; }
  }
  info() { const { key, ...s } = this.read(); return { ...s, hasKey: !!key }; }
  save(input: unknown) {
    const parsed = settingsInput.safeParse(input);
    if (!parsed.success) throw new Error("AI 설정을 확인하세요.");
    const { provider, endpoint, model, enabled, apiKey, clearKey } = parsed.data;
    if (enabled || endpoint) apiEndpoint({ provider, endpoint });
    const previous = this.read();
    let key = clearKey || provider !== previous.provider || endpoint !== previous.endpoint ? undefined : previous.key;
    if (apiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("이 PC에서 보안 키 저장을 사용할 수 없습니다.");
      key = safeStorage.encryptString(apiKey.trim()).toString("base64");
    }
    if (enabled && (!key || !model)) throw new Error("AI 사용에는 선택한 제공사의 API 키와 모델 ID가 필요합니다.");
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify({ provider, endpoint, model, enabled, key }), { mode: 0o600 });
    renameSync(temporary, this.path);
    return this.info();
  }
  config(): AIConfig {
    const s = this.read();
    if (!s.enabled || !s.key || !safeStorage.isEncryptionAvailable()) return {};
    try { return { provider: s.provider, endpoint: s.endpoint, model: s.model, apiKey: safeStorage.decryptString(Buffer.from(s.key, "base64")) }; }
    catch { return {}; }
  }
}
