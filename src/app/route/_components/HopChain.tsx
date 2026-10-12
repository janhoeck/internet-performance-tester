import { Monitor } from "lucide-react";
import { cn } from "@/lib/cn";
import { fmtMs } from "@/lib/format";
import { ROLE_COLOR, ROLE_SHORT, type HopView } from "./route-utils";

/** Mini-Topologie: PC und alle Hops als Kette; stumme Hops gestrichelt. */
export function HopChain({ views, label }: { views: readonly HopView[]; label: string }) {
  return (
    <ol aria-label={label} className="flex flex-wrap items-stretch gap-y-3">
      <li className="flex items-center">
        <div className="flex w-20 flex-col items-center gap-1 text-center">
          <span className="grid size-9 place-items-center rounded-full bg-raised ring-1 ring-inset ring-line-strong" style={{ color: "var(--np-seg-pc)" }}>
            <Monitor aria-hidden className="size-4" strokeWidth={2} />
          </span>
          <span className="text-2xs font-medium text-fg-2">Dein PC</span>
        </div>
      </li>
      {views.map((v) => (
        <li key={v.hop.hop} className="flex items-center">
          <span aria-hidden className={cn("h-px w-4 sm:w-6", v.silent ? "border-t border-dashed border-line-control" : "bg-line-strong")} />
          <div className="flex w-20 flex-col items-center gap-1 text-center" title={v.hop.ip ?? "antwortet nicht"}>
            <span
              className={cn(
                "np-num grid size-9 place-items-center rounded-full text-xs font-semibold",
                v.silent ? "border border-dashed border-line-control text-fg-3" : "bg-raised ring-2 ring-inset",
              )}
              style={v.silent ? undefined : { color: ROLE_COLOR[v.role], ["--tw-ring-color" as string]: ROLE_COLOR[v.role] }}
            >
              {v.hop.hop}
            </span>
            <span className="text-2xs font-medium text-fg-2">{ROLE_SHORT[v.role]}</span>
            <span className="np-num text-2xs text-fg-3">{v.silent ? "stumm" : fmtMs(v.rttMedian)}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}
