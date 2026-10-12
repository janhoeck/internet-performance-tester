"use client";

import { createContext, useContext, type ReactNode } from "react";
import { type HostOs, type OsWording, osWording } from "@/lib/shared/platform";

// Betriebssystem des Mess-PCs. Next läuft auf demselben Rechner wie die Mess-Engine, das Root-Layout
// gibt daher process.platform des Servers weiter. Ohne Provider (Vorschau, Tests) gilt Windows.
const PlatformContext = createContext<HostOs>("windows");

export function PlatformProvider({ os, children }: { os: HostOs; children: ReactNode }) {
  return <PlatformContext.Provider value={os}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): HostOs {
  return useContext(PlatformContext);
}

/** Betriebssystemabhängige Formulierungen (Ereignisprotokoll, Task-Manager, …). */
export function useOsWording(): OsWording {
  return osWording(useContext(PlatformContext));
}
