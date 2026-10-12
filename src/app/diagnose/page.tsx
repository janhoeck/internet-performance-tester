import type { Metadata } from "next";
import { DiagnoseView } from "./_components/DiagnoseView";

export const metadata: Metadata = { title: "Diagnose" };

export default function DiagnosePage() {
  return <DiagnoseView />;
}
