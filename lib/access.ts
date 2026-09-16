import { AppError } from "./errors";

export function checkOrigin(request: Request) {
  if (
    request.method !== "GET" &&
    request.headers.get("origin") !== new URL(request.url).origin
  )
    throw new AppError(403, "허용되지 않은 요청입니다.");
}
export function localAccess(
  request: Request,
  flag: string | undefined,
  production: boolean,
) {
  return (
    !production &&
    flag === "1" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)
  );
}
export function coordinatorAccess(
  email: string | undefined,
  allowlist: string | undefined,
) {
  if (!email) throw new AppError(401, "코디네이터 로그인이 필요합니다.");
  const allowed = (allowlist ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(email.toLowerCase()))
    throw new AppError(403, "이 계정에는 코디네이터 권한이 없습니다.");
  return email;
}
