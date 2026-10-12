import type { Metadata } from "next";
import { Dashboard } from "./_dashboard/Dashboard";

// title.template des Root-Layouts gilt nur für Unterseiten – hier daher absolut
export const metadata: Metadata = { title: { absolute: "Live-Dashboard – Netzpuls" } };

export default function LiveDashboardPage() {
  return <Dashboard />;
}
