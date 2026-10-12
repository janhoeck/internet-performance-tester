import type { Metadata } from "next";
import { EreignisseView } from "./_components/EreignisseView";

export const metadata: Metadata = { title: "Ereignisse" };

/** Ereignisse: Zeitleiste aller Abbrüche, Ausfälle, Spitzen, Router-Meldungen und Notizen. */
export default function EreignissePage() {
  return <EreignisseView />;
}
