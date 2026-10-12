import type { Metadata } from "next";
import { RouteView } from "./_components/RouteView";

export const metadata: Metadata = { title: "Route" };

export default function RoutePage() {
  return <RouteView />;
}
