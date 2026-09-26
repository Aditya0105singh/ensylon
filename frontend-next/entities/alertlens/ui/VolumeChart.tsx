"use client";

import { useState } from "react";
import clsx from "clsx";

export interface VolumeBucket {
  label: string;
  total: number;
  correlated: number;
  critical: number;
}

/** Rounds the axis maximum up to a 1/2/5 x 10^k step so ticks read cleanly. */
function niceMax(max: number, intervals = 4) {
  const raw = Math.max(1, max) / intervals;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  return { step, max: step * intervals };
}

const COLORS = { ingested: "#86efac", correlated: "#15803d", critical: "#ef4444" };

export function VolumeChart({ buckets }: { buckets: VolumeBucket[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const peak = Math.max(1, ...buckets.map((b) => b.total));
  const { step, max } = niceMax(peak);
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);
  const n = buckets.length;
  const labelEvery = Math.max(1, Math.ceil(n / 6));
  const H = 200;
  const hb = hover !== null ? buckets[hover] : null;
  const hx = hover !== null ? ((hover + 0.5) / n) * 100 : 0;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-700 mb-3">
        {[
          ["Ingested", COLORS.ingested],
          ["Correlated", COLORS.correlated],
          ["Critical", COLORS.critical],
        ].map(([l, c]) => (
          <span key={l} className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full" style={{ background: c }} />
            {l}
          </span>
        ))}
      </div>

      <div className="flex gap-2 pt-4">
        <div className="relative shrink-0 w-9 text-[11px] text-gray-500 text-right" style={{ height: H }}>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2 tabular-nums" style={{ bottom: `${(t / max) * 100}%` }}>
              {t}
            </span>
          ))}
        </div>

        <div className="relative flex-1 min-w-0">
          <div className="relative border-l border-gray-300" style={{ height: H }} onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <div
                key={t}
                className={clsx("absolute inset-x-0 border-t pointer-events-none", t === 0 ? "border-gray-300" : "border-dashed border-gray-200")}
                style={{ bottom: `${(t / max) * 100}%` }}
              />
            ))}
            {buckets.map((b, i) =>
              i % labelEvery === 0 ? (
                <div key={i} className="absolute inset-y-0 border-l border-dashed border-gray-100 pointer-events-none" style={{ left: `${((i + 0.5) / n) * 100}%` }} />
              ) : null
            )}

            <div className="absolute inset-0 flex items-end gap-[3px] px-[2px]">
              {buckets.map((b, i) => (
                <div
                  key={i}
                  className={clsx("relative flex-1 h-full min-w-0 transition-opacity", hover !== null && hover !== i && "opacity-60")}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  tabIndex={0}
                  role="img"
                  aria-label={`${b.label}: ${b.total} ingested, ${b.correlated} correlated, ${b.critical} critical`}
                >
                  <div className="kpi-bar absolute bottom-0 inset-x-0 rounded-t-[3px]" style={{ height: `${(b.total / max) * 100}%`, background: COLORS.ingested, animationDelay: `${300 + i * 30}ms` }} />
                  <div className="kpi-bar absolute bottom-0 inset-x-0 rounded-t-[3px]" style={{ height: `${(b.correlated / max) * 100}%`, background: COLORS.correlated, animationDelay: `${380 + i * 30}ms` }} />
                  <div className="kpi-bar absolute bottom-0 inset-x-0 rounded-t-[3px]" style={{ height: `${(b.critical / max) * 100}%`, background: COLORS.critical, animationDelay: `${460 + i * 30}ms` }} />
                </div>
              ))}
            </div>

            {hb && (
              <>
                <div className="absolute inset-y-0 border-l border-dashed border-gray-400 pointer-events-none" style={{ left: `${hx}%` }} />
                <div
                  className="absolute z-10 pointer-events-none rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs shadow-lg min-w-[140px]"
                  style={{
                    top: 4,
                    left: `${hx}%`,
                    transform: hx > 60 ? "translateX(calc(-100% - 10px))" : "translateX(10px)",
                  }}
                >
                  <div className="font-semibold text-gray-900 mb-1.5">{hb.label}</div>
                  {[
                    ["Ingested", hb.total, COLORS.ingested, "text-gray-900"],
                    ["Correlated", hb.correlated, COLORS.correlated, "text-gray-900"],
                    ["Critical", hb.critical, COLORS.critical, "text-red-600"],
                  ].map(([l, v, c, t]) => (
                    <div key={l as string} className="flex items-center gap-2 py-0.5">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: c as string }} />
                      <span className="text-gray-600">{l}</span>
                      <b className={clsx("ml-auto tabular-nums", t as string)}>{v}</b>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="relative h-5 mt-1.5 text-[11px] text-gray-600">
            {buckets.map((b, i) =>
              i % labelEvery === 0 ? (
                <span
                  key={i}
                  className="absolute top-0 whitespace-nowrap"
                  style={{ left: `${((i + 0.5) / n) * 100}%`, transform: i / n > 0.8 ? "translateX(-100%)" : i === 0 ? "none" : "translateX(-50%)" }}
                >
                  {b.label}
                </span>
              ) : null
            )}
          </div>
        </div>
      </div>
      <p className="text-[11px] text-gray-500 mt-2">Hover a bar for the per-bucket breakdown. Critical = alerts with critical severity.</p>
    </div>
  );
}
