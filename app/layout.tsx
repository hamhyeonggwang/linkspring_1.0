import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "이어:봄 LinkSpring",
  description:
    "치료·상담·교육 등 비영리 서비스의 빈 일정과 기다리는 대기자를 연결합니다.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
