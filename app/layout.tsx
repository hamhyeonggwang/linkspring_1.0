import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title:"이어:봄 LinkSpring", description:"빈 치료 시간을 아동의 새로운 기회로 연결하는 치료 회기 운영 시스템", icons:{icon:"/favicon.svg",shortcut:"/favicon.svg"} };
export default function RootLayout({children}:{children:React.ReactNode}) { return <html lang="ko"><body>{children}</body></html>; }
