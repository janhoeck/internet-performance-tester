import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Klassen zusammenführen. tailwind-merge kennt eigene Theme-Namen nicht von selbst:
 * Ohne diese Erweiterung würde z. B. `shadow-panel` als Schattenfarbe gelten.
 * Schriftgrößen nutzen bewusst die T-Shirt-Namen (2xs … 5xl), die tailwind-merge
 * bereits als Größen erkennt – daher keine eigenen Namen wie `text-kpi`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      shadow: ["panel", "overlay", "glow", "glow-crit"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
