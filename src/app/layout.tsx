import type { Metadata, Viewport } from "next";
import { AppShell } from "@/components/shell/AppShell";
import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Netzpuls", template: "%s – Netzpuls" },
  description: "Langzeit-Leitungstest und Ursachenanalyse für Ping-Spitzen und Paketverlust",
};

export const viewport: Viewport = {
  themeColor: "#040B18",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de" data-motion="on" className={fontVariables} suppressHydrationWarning>
      <body>
        <AppShell sidebarFooter={<span className="np-num">Engine 127.0.0.1:3901</span>}>{children}</AppShell>
      </body>
    </html>
  );
}
