"use client";

import { Text } from "@tremor/react";
import { useCountUp } from "@/entities/alertlens/ui/KpiCards";
import type { IconType } from "react-icons/lib";
import clsx from "clsx";

type StatCardProps = {
  label: string;
  value: string | number;
  hint?: string;
  icon?: IconType | React.ElementType;
  color?: "orange" | "red" | "blue" | "emerald" | "amber" | "gray" | "green";
  className?: string;
  /** Real per-bucket values (e.g. alerts/minute) rendered as a tiny bar
   * sparkline in the card footer. Omit for cards with nothing meaningful to
   * chart - never backfilled with fake data. */
  sparkline?: number[];
};

const ACCENT: Record<
  NonNullable<StatCardProps["color"]>,
  { bar: string; iconBg: string; iconText: string; spark: string }
> = {
  green: { bar: "bg-green-500", iconBg: "bg-green-100", iconText: "text-green-700", spark: "bg-green-300" },
  emerald: { bar: "bg-emerald-500", iconBg: "bg-emerald-100", iconText: "text-emerald-700", spark: "bg-emerald-300" },
  orange: { bar: "bg-orange-500", iconBg: "bg-orange-100", iconText: "text-orange-700", spark: "bg-orange-300" },
  red: { bar: "bg-red-500", iconBg: "bg-red-100", iconText: "text-red-700", spark: "bg-red-300" },
  blue: { bar: "bg-blue-500", iconBg: "bg-blue-100", iconText: "text-blue-700", spark: "bg-blue-300" },
  amber: { bar: "bg-amber-500", iconBg: "bg-amber-100", iconText: "text-amber-700", spark: "bg-amber-300" },
  gray: { bar: "bg-gray-400", iconBg: "bg-gray-100", iconText: "text-gray-600", spark: "bg-gray-300" },
};

const GRADIENT: Record<NonNullable<StatCardProps["color"]>, string> = {
  green: "linear-gradient(160deg,#fff 55%,#f0fdf4)",
  emerald: "linear-gradient(160deg,#fff 55%,#ecfdf5)",
  orange: "linear-gradient(160deg,#fff 55%,#fff7ed)",
  red: "linear-gradient(160deg,#fff 55%,#fef2f2)",
  blue: "linear-gradient(160deg,#fff 55%,#eff6ff)",
  amber: "linear-gradient(160deg,#fff 55%,#fffbeb)",
  gray: "linear-gradient(160deg,#fff 55%,#f9fafb)",
};

/** Numbers count up from zero; strings ("97.8%", "15m") are shown as given. */
function AnimatedValue({ value }: { value: string | number }) {
  const n = typeof value === "number" ? value : NaN;
  const shown = useCountUp(Number.isFinite(n) ? n : 0);
  return <>{typeof value === "number" ? shown : value}</>;
}

export function StatCard({
  label,
  value,
  hint,
  icon: IconComp,
  color = "green",
  className,
  sparkline,
}: StatCardProps) {
  const a = ACCENT[color];
  const max = sparkline && sparkline.length ? Math.max(1, ...sparkline) : 1;

  return (
    <div
      className={clsx(
        "kpi-card relative rounded-2xl border border-white/80 p-4 overflow-hidden",
        className
      )}
      style={{ background: GRADIENT[color], boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -12px rgba(16,24,40,.12)" }}
    >
      <div className="flex items-start justify-between gap-2">
        <Text className="truncate text-xs font-semibold text-gray-600">{label}</Text>
        {IconComp && (
          <div className={clsx("rounded-xl p-2 shrink-0", a.iconBg, a.iconText)}>
            <IconComp size={18} />
          </div>
        )}
      </div>
      <div className="mt-2 text-3xl font-extrabold text-gray-900 tabular-nums leading-none">
        <AnimatedValue value={value} />
      </div>
      {hint && <Text className="mt-1.5 text-xs text-gray-600">{hint}</Text>}

      {sparkline && sparkline.length > 1 && (
        <div className="mt-2.5 flex items-end gap-[2px] h-6">
          {sparkline.map((v, i) => (
            <div
              key={i}
              className={clsx("kpi-bar flex-1 rounded-t-[2px]", a.spark)}
              style={{ height: `${Math.max(8, (v / max) * 100)}%`, animationDelay: `${i * 40}ms` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
