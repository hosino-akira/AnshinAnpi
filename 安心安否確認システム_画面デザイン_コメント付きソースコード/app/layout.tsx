import type { Metadata, Viewport } from "next";
import "./globals.css";

// Androidのホーム画面やブラウザタブに表示されるサイト情報です。
export const metadata: Metadata = {
  title: "安心安否確認システム",
  description: "顔認識で登録済みの連絡先へ安否確認メールを送信する、Androidタッチ端末向け画面デザインです。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

// キオスク端末では誤操作による画面拡大を防ぎ、表示倍率を固定します。
// 通常のWeb公開へ転用する場合は maximumScale / userScalable を削除してください。
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // lang="ja" を指定し、スクリーンリーダーへ日本語コンテンツであることを伝えます。
  return <html lang="ja"><body>{children}</body></html>;
}
