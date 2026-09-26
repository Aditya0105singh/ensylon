"use client";

import { useState } from "react";
import clsx from "clsx";

export interface SeveritySlice {
  severity: string;
  count: number;
  color: string;
}

/** Interactive severity donut: hover a slice or a legend row to focus it. */
export function SeverityDonut({ slices }: { slices: SeveritySlice[] }) {
  const [active, setActive] = useState<string | null>(null);
  const total = slices.reduce((n, s) => n + s.count, 0) || 1;
  const r = 15.9155;
  const focus = slices.find((s) => s.severity === active);
  let offset = 25; // start at 12 o'clock

  return (
    // Intrinsic layout, no breakpoints: donut and legend sit side by side while
    // the box has room and the legend wraps under the donut when it doesn't; the
    // legend grid fits as many columns as its own width allows.
    <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-4" onMouseLeave={() => setActive(null)}>
      <div className="relative w-36 h-36 sm:w-44 sm:h-44 shrink-0">
        <svg viewBox="0 0 36 36" className="w-full h-full" role="img" aria-label={`Alerts by severity, ${total} total`}>
          <circle cx="18" cy="18" r={r} fill="none" stroke="#f3f4f6" strokeWidth="4.5" />
          {slices.map((s, i) => {
            const pct = (100 * s.count) / total;
            const gap = slices.length > 1 ? Math.min(0.8, pct / 2) : 0;
            const el = (
              <circle
                key={s.severity}
                className="kpi-ring cursor-pointer"
                cx="18"
                cy="18"
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={active === s.severity ? 6 : 4.5}
                pathLength={100}
                strokeDasharray={`${pct - gap} ${100 - pct + gap}`}
                strokeDashoffset={offset}
                opacity={active && active !== s.severity ? 0.35 : 1}
                style={{ transition: "stroke-width .2s, opacity .2s", animationDelay: `${300 + i * 120}ms` }}
                onMouseEnter={() => setActive(s.severity)}
              />
            );
            offset -= pct;
            return el;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-2xl font-extrabold text-gray-900 tabular-nums leading-none">
            {(focus ? focus.count : total).toLocaleString()}
          </span>
          <span className="text-[11px] text-gray-600 mt-1 capitalize">
            {focus ? `${focus.severity} · ${Math.round((100 * focus.count) / total)}%` : "Total alerts"}
          </span>
        </div>
      </div>

      <div className="flex-1 basis-64 min-w-0 flex flex-col gap-4">
        {/* Proportion bar: the same slices as the donut, laid out flat. */}
        <div className="flex h-3 w-full rounded-full overflow-hidden bg-gray-100">
          {slices.map((s) => (
            <div
              key={s.severity}
              className="kpi-hbar h-full transition-opacity"
              style={{ width: `${(100 * s.count) / total}%`, background: s.color, opacity: active && active !== s.severity ? 0.35 : 1, transformOrigin: "left" }}
              onMouseEnter={() => setActive(s.severity)}
              title={`${s.severity}: ${s.count}`}
            />
          ))}
        </div>
        <ul
          className="grid gap-2 text-xs"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(7.5rem, 1fr))" }}
        >
          {slices.map((s) => {
            const pct = Math.round((100 * s.count) / total);
            return (
              <li
                key={s.severity}
                onMouseEnter={() => setActive(s.severity)}
                className={clsx(
                  "rounded-xl border px-3 py-2.5 transition-all cursor-default",
                  active === s.severity ? "border-green-300 bg-green-50 -translate-y-0.5 shadow-sm" : "border-gray-100 bg-white/70"
                )}
                style={{ borderTop: `3px solid ${s.color}` }}
              >
                <div className="capitalize text-gray-600 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                  {s.severity}
                </div>
                <div className="mt-1 flex items-baseline gap-1.5 flex-wrap">
                  <b className="text-lg text-gray-900 tabular-nums">{s.count.toLocaleString()}</b>
                  <span className="text-gray-500 tabular-nums">{pct}%</span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
