import type { Metadata } from "next";
import { VerlaufView } from "./_components/VerlaufView";

export const metadata: Metadata = { title: "Verlauf" };

/** Verlauf: Messwerte über Stunden und Tage plus A/B-Vergleich zweier Langzeittests. */
export default function VerlaufPage() {
  return <VerlaufView />;
}
