"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

interface ShellState {
  navOpen: boolean;
  setNavOpen: (open: boolean) => void;
}

const ShellContext = createContext<ShellState | null>(null);

/** Hält nur den Zustand der mobilen Navigation (Drawer). */
export function ShellProvider({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  const value = useMemo(() => ({ navOpen, setNavOpen }), [navOpen]);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellState {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell() außerhalb von <ShellProvider> verwendet");
  return ctx;
}
