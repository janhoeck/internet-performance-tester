import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { SettingsView } from "./_components/SettingsView";

export const metadata: Metadata = { title: "Einstellungen" };

export default function EinstellungenPage() {
  return (
    <>
      <PageHeader
        title="Einstellungen"
        description="Router-Zugang, Messziele, Zeitpläne, Schwellen und Datenhaltung. Änderungen gelten nach dem Speichern sofort für die Mess-Engine."
      />
      <SettingsView />
    </>
  );
}
