import type { Metadata } from "next";
import { BerichtView } from "./_components/BerichtView";

export const metadata: Metadata = { title: "Bericht" };

export default function BerichtPage() {
  return <BerichtView />;
}
