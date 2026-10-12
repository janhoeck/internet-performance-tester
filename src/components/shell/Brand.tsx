import { cn } from "@/lib/cn";

/** Bildmarke: Pulslinie (Glasfaser-Cyan), die in ein Paket (Laser-Violett) mündet. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-8 shrink-0", className)}>
      <rect x="0.5" y="0.5" width="31" height="31" rx="9" style={{ fill: "var(--np-sunken)", stroke: "var(--np-line-strong)" }} />
      <path
        d="M4 17h6l2.5-7 4 13 2.5-6H24"
        fill="none"
        style={{ stroke: "var(--np-fiber)" }}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="27" cy="17" r="2.25" style={{ fill: "var(--np-laser)" }} />
    </svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <BrandMark />
      {!compact && (
        <span className="leading-tight">
          <span className="block font-display text-[17px] font-semibold tracking-tight text-fg">Netzpuls</span>
          <span className="block text-2xs text-fg-3">Leitungsdiagnose</span>
        </span>
      )}
    </span>
  );
}
