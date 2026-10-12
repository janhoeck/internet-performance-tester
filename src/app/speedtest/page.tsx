import type { Metadata } from "next";
import { SpeedtestView } from "./_components/SpeedtestView";

export const metadata: Metadata = { title: "Speedtest" };

export default function SpeedtestPage() {
  return <SpeedtestView />;
}
