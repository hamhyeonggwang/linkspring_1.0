import { contextBridge, ipcRenderer } from "electron";
import { operations, type Operation } from "../shared/desktop";
contextBridge.exposeInMainWorld("linkspring", Object.freeze({
  async call(operation: Operation, payload?: unknown) {
    if (!operations.includes(operation)) throw new Error("지원하지 않는 요청입니다.");
    const response = await ipcRenderer.invoke("linkspring:request", operation, payload);
    if (!response.ok) throw new Error(response.error);
    return response.data;
  },
}));
