import type { ComponentPropsWithRef } from "react";
import { LoaderCircle, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  /**
   * Zeigt Spinner, setzt aria-busy/aria-disabled und ignoriert Klicks. Der Button bleibt fokussierbar
   * (kein natives disabled), damit der Tastaturfokus nicht auf <body> zurückfällt.
   */
  loading?: boolean;
}

const VARIANT: Record<Variant, string> = {
  // Glasfaser-Fläche mit dunklem Text (10,5:1), Glow nur bei Hover
  primary: "bg-fiber-strong text-fg-invert hover:bg-fiber hover:shadow-glow active:bg-fiber-deep",
  secondary: "bg-raised text-fg ring-1 ring-inset ring-line-strong hover:bg-overlay hover:ring-line-control",
  ghost: "text-fg-2 hover:bg-raised hover:text-fg",
  danger: "text-crit ring-1 ring-inset ring-crit/40 hover:bg-crit/12",
};

const SIZE: Record<Size, string> = {
  sm: "h-7 gap-1.5 rounded-md px-2.5 text-xs",
  md: "h-9 gap-2 rounded-lg px-3.5 text-sm",
  lg: "h-11 gap-2 rounded-lg px-5 text-base",
};

const ICON_SIZE: Record<Size, string> = { sm: "size-3.5", md: "size-4", lg: "size-4.5" };

/** Icon-only-Buttons brauchen aria-label. Beschriftung = Verb + Objekt ("Messung starten"). */
export function Button({
  variant = "secondary",
  size = "md",
  icon: Icon,
  iconRight: IconRight,
  loading = false,
  disabled,
  className,
  children,
  type = "button",
  onClick,
  ...rest
}: ButtonProps) {
  const blocked = loading && !disabled;
  // Handler nur anhängen, wenn nötig: Button bleibt so in Server-Komponenten nutzbar (dort gibt es
  // weder onClick noch loading – Event-Handler dürfen nicht über die Server/Client-Grenze).
  const handleClick: ButtonProps["onClick"] =
    onClick || (loading && type === "submit")
      ? (e) => {
          if (loading) {
            e.preventDefault(); // auch kein Formular-Submit
            return;
          }
          onClick?.(e);
        }
      : undefined;
  return (
    <button
      type={type}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={blocked || undefined}
      onClick={handleClick}
      className={cn(
        "inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,box-shadow,color] duration-150 ease-np",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fiber",
        "disabled:pointer-events-none disabled:opacity-45",
        blocked && "cursor-progress opacity-80",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <LoaderCircle aria-hidden className={cn(ICON_SIZE[size], "animate-spin")} />
      ) : (
        Icon && <Icon aria-hidden className={ICON_SIZE[size]} strokeWidth={2} />
      )}
      {children}
      {IconRight && !loading && <IconRight aria-hidden className={ICON_SIZE[size]} strokeWidth={2} />}
    </button>
  );
}
