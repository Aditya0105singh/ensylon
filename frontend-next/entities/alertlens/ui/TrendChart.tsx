"use client";

import { useState } from "react";
import clsx from "clsx";

export interface TrendPoint {
  label: string;
  noise: number; // cumulative noise reduction, 0-100
  alerts: number; // cumulative alerts seen
  incidents: number; // cumulative incidents opened
}

const GREEN = "#15803d";

/** Cumulative noise reduction over time, with axes, gridlines and a hover tooltip. */
export function TrendChart({ points }: { points: TrendPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  const H = 200;
  const W = 600;
  const ticks = [0, 25, 50, 75, 100];
  if (n < 2) return <p className="text-xs text-gray-500">Not enough time buckets to draw a trend.</p>;

  const px = (i: number) => (i / (n - 1)) * W;
  const py = (v: number) => H - (Math.min(100, Math.max(0, v)) / 100) * H;
  const line = points.map((p, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(p.noise).toFixed(1)}`).join(" ");
  const labelEvery = Math.max(1, Math.ceil(n / 3));
  const last = points[n - 1];
  const hp = hover !== null ? points[hover] : null;
  const hx = hover !== null ? (hover / (n - 1)) * 100 : 0;
  const idxFromEvent = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(n - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * (n - 1))));
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-700 mb-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full" style={{ background: GREEN }} />
          Noise reduction (cumulative)
        </span>
        <span className="ml-auto font-bold text-green-800 tabular-nums">{last.noise.toFixed(1)}% now</span>
      </div>

      <div className="flex gap-2 pt-4">
        <div className="relative shrink-0 w-9 text-[11px] text-gray-500 text-right" style={{ height: H }}>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2 tabular-nums" style={{ bottom: `${t}%` }}>
              {t}%
            </span>
          ))}
        </div>

        <div className="relative flex-1 min-w-0">
          <div
            className="relative border-l border-gray-300"
            style={{ height: H }}
            onMouseMove={(e) => setHover(idxFromEvent(e))}
            onMouseLeave={() => setHover(null)}
          >
            {ticks.map((t) => (
              <div
                key={t}
                className={clsx("absolute inset-x-0 border-t pointer-events-none", t === 0 ? "border-gray-300" : "border-dashed border-gray-200")}
                style={{ bottom: `${t}%` }}
              />
            ))}
            {points.map((_, i) =>
              i % labelEvery === 0 ? (
                <div key={i} className="absolute inset-y-0 border-l border-dashed border-gray-100 pointer-events-none" style={{ left: `${(i / (n - 1)) * 100}%` }} />
              ) : null
            )}

            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full overflow-visible" role="img" aria-label={`Cumulative noise reduction, now ${last.noise.toFixed(1)}%`}>
              <defs>
                <linearGradient id="trend-fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="#22c55e" stopOpacity="0.35" />
                  <stop offset="1" stopColor="#22c55e" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <path className="kpi-fade" d={`${line} L${W},${H} L0,${H} Z`} fill="url(#trend-fill)" />
              <path className="kpi-draw" d={line} pathLength={1} fill="none" stroke={GREEN} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </svg>

            {/* Dots are HTML so they stay round while the SVG stretches. */}
            <span
              className="kpi-pulse-dot absolute w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white border-2 pointer-events-none"
              style={{ left: "100%", top: `${100 - last.noise}%`, borderColor: GREEN }}
            />
            {hp && (
              <>
                <div className="absolute inset-y-0 border-l border-dashed border-gray-400 pointer-events-none" style={{ left: `${hx}%` }} />
                <span
                  className="absolute w-3.5 h-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full pointer-events-none"
                  style={{ left: `${hx}%`, top: `${100 - hp.noise}%`, background: GREEN, boxShadow: "0 0 0 3px #fff" }}
                />
                <div
                  className="absolute z-10 pointer-events-none rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs shadow-lg min-w-[150px]"
                  style={{ top: 4, left: `${hx}%`, transform: hx > 55 ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}
                >
                  <div className="font-semibold text-gray-900 mb-1.5">{hp.label}</div>
                  {[
                    ["Noise reduction", `${hp.noise.toFixed(1)}%`, "text-green-700"],
                    ["Alerts so far", hp.alerts.toLocaleString(), "text-gray-900"],
                    ["Incidents so far", hp.incidents.toLocaleString(), "text-gray-900"],
                  ].map(([l, v, t]) => (
                    <div key={l} className="flex items-center gap-3 py-0.5">
                      <span className="text-gray-600">{l}</span>
                      <b className={clsx("ml-auto tabular-nums", t)}>{v}</b>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="relative h-5 mt-1.5 text-[11px] text-gray-600">
            {points.map((p, i) =>
              i % labelEvery === 0 ? (
                <span
                  key={i}
                  className="absolute top-0 whitespace-nowrap"
                  style={{ left: `${(i / (n - 1)) * 100}%`, transform: i === 0 ? "none" : i / n > 0.8 ? "translateX(-100%)" : "translateX(-50%)" }}
                >
                  {p.label}
                </span>
              ) : null
            )}
          </div>
        </div>
      </div>
      <p className="text-[11px] text-gray-500 mt-2">
        Noise reduction = 1 − incidents opened so far ÷ alerts seen so far. Hover for the running totals.
      </p>
    </div>
  );
}
