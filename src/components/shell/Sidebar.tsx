"use client";

import { Suspense, useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { BrandMark } from "./Brand";
import { NAV, isActive } from "./nav";
import { useShell } from "./ShellProvider";

/** id der Sidebar (für aria-controls am Menü-Button) */
export const SIDEBAR_ID = "np-sidebar";
/** id des Menü-Buttons in der Statusleiste (Fokus kehrt beim Schließen dorthin zurück) */
export const NAV_TOGGLE_ID = "np-nav-toggle";
const MOBILE_QUERY = "(max-width: 767.98px)";

/** Reine Darstellung – ohne usePathname, dient auch als Suspense-Fallback. */
function NavList({ pathname, onNavigate }: { pathname?: string | null; onNavigate?: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      {NAV.map((group, gi) => (
        <div key={group.label} className={cn(gi > 0 && "md:max-xl:border-t md:max-xl:border-line md:max-xl:pt-4")}>
          <p className="px-2.5 pb-1.5 text-2xs font-medium text-fg-4 md:max-xl:sr-only">{group.label}</p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = isActive(item.href, pathname);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    title={item.hint}
                    aria-current={active ? "page" : undefined}
                    onClick={onNavigate}
                    className={cn(
                      "group relative flex h-9 items-center gap-3 rounded-lg px-2.5 text-sm text-fg-2 transition-colors duration-150",
                      "hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-fiber",
                      "md:max-xl:justify-center md:max-xl:px-0",
                      active && "bg-fiber/10 text-fg hover:bg-fiber/14",
                    )}
                  >
                    {active && (
                      <span aria-hidden className="absolute -left-3 bottom-2 top-2 w-0.5 rounded-r-full bg-fiber shadow-glow" />
                    )}
                    <Icon
                      aria-hidden
                      className={cn("size-[18px] shrink-0", active ? "text-fiber" : "text-fg-3 group-hover:text-fg-2")}
                      strokeWidth={1.75}
                    />
                    <span className="truncate md:max-xl:sr-only">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ActiveNavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return <NavList pathname={pathname} onNavigate={onNavigate} />;
}

/**
 * < md: Drawer (über Menü-Button in der Statusleiste)
 * md–xl: schmale Leiste nur mit Icons (Tooltip = title)
 * ab xl: volle Sidebar 256 px
 */
export function Sidebar({ footer }: { footer?: ReactNode }) {
  const { navOpen, setNavOpen } = useShell();
  const close = () => setNavOpen(false);
  const asideRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);

  // Drawer (< md): beim Öffnen ersten Link fokussieren, beim Schließen Fokus zurück zum Menü-Button
  useEffect(() => {
    const aside = asideRef.current;
    if (!aside || typeof window === "undefined" || !window.matchMedia(MOBILE_QUERY).matches) {
      wasOpen.current = navOpen;
      return;
    }
    if (navOpen) {
      aside.querySelector<HTMLElement>("nav a[href]")?.focus();
    } else if (wasOpen.current) {
      const active = document.activeElement;
      if (!active || active === document.body || aside.contains(active)) document.getElementById(NAV_TOGGLE_ID)?.focus();
    }
    wasOpen.current = navOpen;
  }, [navOpen]);

  return (
    <>
      <div
        aria-hidden
        onClick={close}
        className={cn("fixed inset-0 z-40 bg-void/70 transition-opacity md:hidden", navOpen ? "opacity-100" : "pointer-events-none opacity-0")}
      />
      <aside
        ref={asideRef}
        id={SIDEBAR_ID}
        data-slot="sidebar"
        aria-label="Hauptnavigation"
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-line bg-(--np-glass-strong) transition-[translate,transform,visibility] duration-200 ease-np",
          "md:visible md:sticky md:top-0 md:z-30 md:h-dvh md:w-[72px] md:translate-x-0 xl:w-64",
          // geschlossen (< md): unsichtbar = nicht in Tab-Reihenfolge und Barrierefreiheitsbaum
          navOpen ? "translate-x-0" : "invisible -translate-x-full",
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-4 md:max-xl:justify-center md:max-xl:px-0">
          <BrandMark />
          <span className="leading-tight md:max-xl:hidden">
            <span className="block font-display text-[17px] font-semibold tracking-tight text-fg">Netzpuls</span>
            <span className="block text-2xs text-fg-3">Leitungsdiagnose</span>
          </span>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <Suspense fallback={<NavList onNavigate={close} />}>
            <ActiveNavList onNavigate={close} />
          </Suspense>
        </nav>
        {footer && <div className="border-t border-line px-4 py-3 text-2xs text-fg-4 md:max-xl:hidden">{footer}</div>}
      </aside>
    </>
  );
}
