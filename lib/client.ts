// The desktop bridge exposes a fixed set of operations, never arbitrary SQL or files.
export async function appFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!window.linkspring) return fetch(url, init);
  try {
    let data: unknown;
    if (url === "/api/state") {
      data = init?.method === "POST"
        ? await window.linkspring.call("mutate", JSON.parse(String(init.body)))
        : await window.linkspring.call("state");
    } else if (url === "/api/ai/parse-absence") {
      data = await window.linkspring.call("analyze", JSON.parse(String(init?.body)));
    } else throw new Error("지원하지 않는 요청입니다.");
    return new Response(JSON.stringify(data), { status: 200 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "처리하지 못했습니다." }), { status: 400 });
  }
}
