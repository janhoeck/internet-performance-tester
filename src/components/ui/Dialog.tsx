"use client";

import { useEffect, useId, useRef, type FormEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

interface DialogProps {
  /** sichtbar (modal). Tipp: Dialog erst beim Öffnen rendern ({open && <MeinDialog/>}) – dann startet sein Zustand frisch. */
  open: boolean;
  /** Schließen-Wunsch (Esc, Schließen-Knopf, Klick auf den Hintergrund) – Aufrufer setzt open=false */
  onClose: () => void;
  title: string;
  /** Ein Satz unter dem Titel (aria-describedby) */
  description?: ReactNode;
  children?: ReactNode;
  /** Knopfzeile unten rechts: zuerst die harmlose Aktion ("Abbrechen"), rechts die primäre */
  footer?: ReactNode;
  /** Inhalt + Knopfzeile werden zu einem Formular (Enter sendet ab); Submit-Knopf mit type="submit" */
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  /**
   * CSS-Selektor des Elements, das beim Öffnen den Fokus bekommt, z. B. "input[type=radio]:checked".
   * Standard: erstes fokussierbares Element im Inhalt (bei Bestätigungen = die harmlose Aktion).
   */
  initialFocus?: string;
  size?: "sm" | "md" | "lg";
  /**
   * false = nicht schließbar (z. B. während einer laufenden Aktion): weder Klick auf den
   * Hintergrund noch Esc noch der Schließen-Knopf (ausgeblendet) schließen den Dialog.
   */
  dismissible?: boolean;
  className?: string;
}

const SIZE = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-xl" } as const;

/**
 * Modaler Dialog auf Basis von <dialog>.showModal():
 * - Fokusfalle durch den Browser (Rest der Seite ist inert); Fokus beim Öffnen auf das erste
 *   Element im Inhalt (oder initialFocus), beim Schließen zurück zum Auslöser
 * - Esc schließt (cancel-Ereignis -> onClose), Klick auf den Hintergrund schließt – beides nicht bei dismissible={false}
 * - role="dialog" + aria-modal implizit, aria-labelledby/-describedby gesetzt
 * - liegt im Top-Layer: unabhängig von z-index/overflow der Eltern
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  onSubmit,
  initialFocus,
  size = "md",
  dismissible = true,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (!d.contains(document.activeElement)) {
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      d.showModal();
      if (initialFocus) d.querySelector<HTMLElement>(initialFocus)?.focus();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open, initialFocus]);

  // Beim Aushängen (Dialog nur bedingt gerendert) Fokus zurückgeben
  useEffect(() => {
    const d = ref.current;
    return () => {
      if (d?.open) d.close();
      const el = returnFocus.current;
      if (el && el.isConnected) el.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCancel = (e: Event) => {
      e.preventDefault(); // Zustand bleibt beim Aufrufer
      if (dismissible) onClose();
    };
    // Browser schließt in Ausnahmen selbst (z. B. zweimal Esc) -> Zustand nachziehen.
    // Das close-Ereignis kommt asynchron: ist der Dialog inzwischen wieder offen (z. B. nach dem
    // StrictMode-Neustart der Effekte in der Entwicklung), ist es veraltet und wird ignoriert.
    const onNativeClose = () => {
      if (d.open) return;
      if (open) onClose();
      const el = returnFocus.current;
      if (el && el.isConnected) el.focus({ preventScroll: true });
    };
    d.addEventListener("cancel", onCancel);
    d.addEventListener("close", onNativeClose);
    return () => {
      d.removeEventListener("cancel", onCancel);
      d.removeEventListener("close", onNativeClose);
    };
  }, [onClose, open, dismissible]);

  const body = (
    <>
      {children && <div className="px-5 pb-1 text-sm text-fg-2">{children}</div>}
      {footer && <div className="flex flex-wrap items-center justify-end gap-2 px-5 pb-5 pt-4">{footer}</div>}
    </>
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onClick={(e) => {
        // Klick auf ::backdrop trifft das dialog-Element selbst
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
      className={cn(
        "np-dialog m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto rounded-2xl border border-line-strong bg-overlay p-0 text-fg shadow-overlay",
        "backdrop:bg-void/75",
        SIZE[size],
        className,
      )}
    >
      <div className="relative">
        <header className="px-5 pb-3 pr-14 pt-5">
          <h2 id={titleId} className="text-lg font-medium text-fg">
            {title}
          </h2>
          {description && (
            <p id={descId} className="mt-1 text-sm text-fg-3">
              {description}
            </p>
          )}
        </header>
        {onSubmit ? (
          <form onSubmit={onSubmit} noValidate>
            {body}
          </form>
        ) : (
          body
        )}
        {/* Im DOM zuletzt: der Anfangsfokus landet so im Inhalt, nicht auf "Schließen" */}
        <button
          type="button"
          onClick={() => {
            if (dismissible) onClose();
          }}
          aria-label="Schließen"
          hidden={!dismissible}
          className="absolute right-3 top-4 grid size-8 place-items-center rounded-lg text-fg-3 hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-fiber"
        >
          <X aria-hidden className="size-4" strokeWidth={2} />
        </button>
      </div>
    </dialog>
  );
}
