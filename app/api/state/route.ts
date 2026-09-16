import { authorize, database, readBody, errorResponse } from "@/lib/server";
import { readState } from "@/lib/state-store";
import { executeAction } from "@/lib/state-actions";
export async function GET(request: Request) {
  try {
    await authorize(request);
    return Response.json(await readState(database()), {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request) {
  try {
    const actor = await authorize(request);
    const result = await executeAction(
      await readBody(request),
      database(),
      actor,
    );
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
