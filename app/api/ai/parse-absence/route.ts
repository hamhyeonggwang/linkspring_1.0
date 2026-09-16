import { z } from "zod";
import { today, scheduleTokens } from "@/lib/domain";
import { analyzeAbsence } from "@/lib/absence";
import {
  AppError,
  authorize,
  errorResponse,
  readBody,
  runtime,
} from "@/lib/server";

export async function POST(request: Request) {
  try {
    await authorize(request);
    const parsed = z
      .object({ text: z.string().trim().min(1).max(1000) })
      .safeParse(await readBody(request, 6000));
    if (!parsed.success)
      throw new AppError(400, "일정 정보와 기준 날짜를 확인해 주세요.");
    const { text } = parsed.data;
    if (scheduleTokens(text) !== text)
      throw new AppError(400, "일정 정보만 추출한 뒤 전송해 주세요.");
    const config = runtime();
    const result = await analyzeAbsence(text, today(), {
      apiKey: config.CLAUDE_API_KEY,
      model: config.CLAUDE_MODEL,
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
