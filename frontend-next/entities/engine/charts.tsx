"use client";

import clsx from "clsx";

/** Small dependency-free SVG charts. Colours are the same set everywhere so a
 * stream keeps its colour across every chart on every page. */

export const SOURCE_COLOR: Record<string, string> = {
  application_logs: "#2563eb",
  cloudwatch_metrics: "#d97706",
  grafana_alerts: "#7c3aed",
};

export const SOURCE_NAME: Record<string, string> = {
  application_logs: "Application logs",
  cloudwatch_metrics: "CloudWatch metrics",
  grafana_alerts: "Grafana alerts",
};

export const PRIORITY_COLOR: Record<string, string> = {
  P1: "#dc2626",
  P2: "#ea580c",
  P3: "#ca8a04",
  P4: "#9ca3af",
};

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-700">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export type StackRow = { label: string; parts: { key: string; value: number }[]; marker?: number };

/** Stacked columns (one per row) with an optional marker line series. */
export function StackedColumns({
  rows,
  colors,
  height = 150,
  markerLabel,
}: {
  rows: StackRow[];
  colors: Record<string, string>;
  height?: number;
  markerLabel?: string;
}) {
  const W = 640;
  const pad = { l: 30, r: 8, t: 8, b: 20 };
  const max = Math.max(1, ...rows.map((r) => Math.max(r.parts.reduce((a, p) => a + p.value, 0), r.marker ?? 0)));
  const bw = (W - pad.l - pad.r) / Math.max(rows.length, 1);
  const y = (v: number) => pad.t + (height - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, Math.ceil(max / 2), max];
  const every = Math.max(1, Math.ceil(rows.length / 8));

  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label="Signals per minute by stream">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="#e5e7eb" strokeWidth={1} />
          <text x={pad.l - 4} y={y(t) + 3} textAnchor="end" fontSize="9" fill="#6b7280">{t}</text>
        </g>
      ))}
      {rows.map((r, i) => {
        let acc = 0;
        return (
          <g key={r.label}>
            {r.parts.map((p) => {
              const y0 = y(acc + p.value);
              const h = y(acc) - y0;
              acc += p.value;
              return h > 0 ? (
                <rect key={p.key} x={pad.l + i * bw + 1} y={y0} width={Math.max(bw - 2, 1)} height={h} fill={colors[p.key] ?? "#9ca3af"} rx={1}>
                  <title>{`${r.label} · ${p.key}: ${p.value}`}</title>
                </rect>
              ) : null;
            })}
            {r.marker ? (
              <circle cx={pad.l + i * bw + bw / 2} cy={y(r.marker)} r={2.6} fill="#dc2626" stroke="#fff" strokeWidth={0.8}>
                <title>{`${r.label} · ${markerLabel ?? "marker"}: ${r.marker}`}</title>
              </circle>
            ) : null}
            {i % every === 0 && (
              <text x={pad.l + i * bw + bw / 2} y={height - 6} textAnchor="middle" fontSize="9" fill="#6b7280">{r.label}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Simple vertical bars for a histogram. */
export function Histogram({
  bins,
  height = 130,
  colorFor,
}: {
  bins: { label: string; value: number }[];
  height?: number;
  colorFor?: (i: number) => string;
}) {
  const W = 420;
  const pad = { l: 28, r: 6, t: 8, b: 20 };
  const max = Math.max(1, ...bins.map((b) => b.value));
  const bw = (W - pad.l - pad.r) / bins.length;
  const y = (v: number) => pad.t + (height - pad.t - pad.b) * (1 - v / max);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label="Anomaly score distribution">
      <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="#d1d5db" />
      <text x={pad.l - 4} y={y(max) + 3} textAnchor="end" fontSize="9" fill="#6b7280">{max}</text>
      <text x={pad.l - 4} y={y(0) + 3} textAnchor="end" fontSize="9" fill="#6b7280">0</text>
      {bins.map((b, i) => (
        <g key={b.label}>
          <rect x={pad.l + i * bw + 2} y={y(b.value)} width={bw - 4} height={y(0) - y(b.value)} rx={2}
            fill={colorFor ? colorFor(i) : "#16a34a"}>
            <title>{`score ${b.label}: ${b.value} signals`}</title>
          </rect>
          <text x={pad.l + i * bw + bw / 2} y={height - 6} textAnchor="middle" fontSize="9" fill="#6b7280">{b.label}</text>
        </g>
      ))}
    </svg>
  );
}

/** Donut with a centre total. */
export function Donut({ parts, size = 130, centre }: { parts: { key: string; value: number; color: string }[]; size?: number; centre?: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label="Incidents by priority">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#f3f4f6" strokeWidth={14} />
      {total > 0 &&
        parts.map((p) => {
          const len = (p.value / total) * c;
          const el = (
            <circle key={p.key} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={p.color} strokeWidth={14}
              strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} transform={`rotate(-90 ${size / 2} ${size / 2})`}>
              <title>{`${p.key}: ${p.value}`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      <text x={size / 2} y={size / 2 - 1} textAnchor="middle" fontSize="20" fontWeight="800" fill="#111827">{total}</text>
      <text x={size / 2} y={size / 2 + 13} textAnchor="middle" fontSize="9" fill="#6b7280">{centre ?? "incidents"}</text>
    </svg>
  );
}

export function ChartCard({ title, sub, children, className }: { title: string; sub?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={clsx("rounded-2xl border border-white/80 p-4 min-w-0", className)}
      style={{ background: "linear-gradient(160deg,#fff 60%,#f0fdf4)", boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -12px rgba(16,24,40,.12)" }}>
      <h2 className="text-sm font-bold text-gray-900">{title}</h2>
      {sub && <p className="text-[11px] text-gray-600 mb-2">{sub}</p>}
      {children}
    </section>
  );
}
