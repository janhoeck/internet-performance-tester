import type { Metadata } from "next";
import { LangzeittestsView } from "./_components/LangzeittestsView";

export const metadata: Metadata = { title: "Langzeittests" };

/** Langzeittests: alle Tests nach Namen, öffnen als Bericht/Diagnose/Verlauf, einzeln löschen. */
export default function LangzeittestsPage() {
  return <LangzeittestsView />;
}
