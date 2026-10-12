import type { Metadata } from "next";
import { PcAdapterView } from "./_components/PcAdapterView";

export const metadata: Metadata = { title: "PC & Adapter" };

/** PC & Adapter: Netzwerkkarte, Link-Abbrüche, Linkgeschwindigkeit, WLAN und VPN dieses PCs. */
export default function PcAdapterPage() {
  return <PcAdapterView />;
}
