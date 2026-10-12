import type { ReactNode } from "react";
import { MotionGovernor } from "@/components/background/MotionGovernor";
import { NetworkBackground } from "@/components/background/NetworkBackground";
import { Toaster } from "@/components/ui/Toast";
import { EngineNotice } from "./EngineNotice";
import { ShellProvider } from "./ShellProvider";
import { Sidebar } from "./Sidebar";
import { LiveStatusBar } from "./StatusBar";

/**
 * App-Rahmen: Hintergrund, Sidebar, Statusleiste (live), Engine-Hinweis, Inhalt, Meldungen.
 * Server-Komponente; interaktive Teile sind eigene Client-Komponenten.
 */
export function AppShell({ children, sidebarFooter }: { children: ReactNode; sidebarFooter?: ReactNode }) {
  return (
    <ShellProvider>
      <a
        href="#inhalt"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-fiber-strong focus:px-3 focus:py-2 focus:text-sm focus:text-fg-invert"
      >
        Zum Inhalt springen
      </a>
      <NetworkBackground />
      <MotionGovernor />
      <div className="flex min-h-dvh">
        <Sidebar footer={sidebarFooter} />
        <div className="flex min-w-0 flex-1 flex-col">
          <LiveStatusBar />
          <EngineNotice />
          <main id="inhalt" tabIndex={-1} className="mx-auto w-full max-w-[1680px] flex-1 px-4 pb-12 pt-6 outline-none sm:px-6 xl:px-8">
            {children}
          </main>
        </div>
      </div>
      <Toaster />
    </ShellProvider>
  );
}
