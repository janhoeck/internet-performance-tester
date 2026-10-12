import type { Metadata } from "next";
import { RouterView } from "./_components/RouterView";

export const metadata: Metadata = { title: "Router" };

/** Router-Seite: Vodafone Station, Kabelanschluss (DOCSIS), Router-Protokoll und Geräteliste. */
export default function RouterPage() {
  return <RouterView />;
}
