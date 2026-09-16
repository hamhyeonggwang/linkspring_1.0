import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { checkOrigin, localAccess, coordinatorAccess } from "./access";

export type Runtime = {
  DB?: D1Database;
  CLAUDE_API_KEY?: string;
  CLAUDE_MODEL?: string;
  COORDINATOR_EMAILS?: string;
  LOCAL_DEV_AUTH?: string;
};
export const runtime = () => env as unknown as Runtime;
import { AppError } from "./errors";
export { AppError };
export async function authorize(request: Request) {
  checkOrigin(request);
  const local = localAccess(
    request,
    runtime().LOCAL_DEV_AUTH,
    process.env.NODE_ENV === "production",
  );
  if (local) return "local-test-coordinator";
  const user = await getChatGPTUser();
  return coordinatorAccess(user?.email, runtime().COORDINATOR_EMAILS);
}
export function database() {
  const db = runtime().DB;
  if (!db) throw new AppError(503, "데이터 저장소 연결을 확인해 주세요.");
  return db;
}
export async function readBody(
  request: Request,
  max = 1_000_000,
): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new AppError(415, "JSON 요청이 필요합니다.");
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, "입력값이 없습니다.");
  const decoder = new TextDecoder();
  let text = "",
    size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new AppError(413, "입력 크기를 줄여 주세요.");
    }
    text += decoder.decode(value, { stream: true });
  }
  try {
    return JSON.parse(text + decoder.decode());
  } catch {
    throw new AppError(400, "입력 형식을 확인해 주세요.");
  }
}
export function errorResponse(error: unknown) {
  if (error instanceof AppError)
    return Response.json({ error: error.message }, { status: error.status });
  // Do not return database statements, provider bodies, or user input.
  return Response.json(
    {
      error:
        "요청을 저장하지 못했습니다. 새로고침 후 상태를 확인하고 다시 시도해 주세요.",
    },
    { status: 503 },
  );
}
