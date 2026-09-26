"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import {
  HiOutlineArrowDown,
  HiOutlineArrowUp,
  HiOutlineBell,
  HiOutlineChevronRight,
  HiOutlineRectangleStack,
  HiOutlineShare,
  HiOutlineSparkles,
  HiOutlineViewfinderCircle,
} from "react-icons/hi2";
import { LuLeaf, LuChartNoAxesColumn } from "react-icons/lu";

export interface KpiData {
  raw: number;
  unique: number;
  correlated: number;
  incidents: number;
  noise: number | null;
  totalSeries: number[];
  correlatedSeries: number[];
  incidentSeries: number[];
  peak: number;
  peakLabel: string;
  p1: number;
}

/** Counts up from 0 on mount / when the target changes (skipped for reduced motion). */
export function useCountUp(target: number, decimals = 0, ms = 900) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setV(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      setV(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return decimals ? v.toFixed(decimals) : Math.round(v).toLocaleString();
}

type Tone = { fg: string; soft: string; chipBg: string; chipFg: string; grad: string };
const TONES: Record<string, Tone> = {
  red: { fg: "#dc2626", soft: "#fee2e2", chipBg: "#fee2e2", chipFg: "#b91c1c", grad: "linear-gradient(160deg,#fff 55%,#fef2f2)" },
  blue: { fg: "#2563eb", soft: "#dbeafe", chipBg: "#dcfce7", chipFg: "#15803d", grad: "linear-gradient(160deg,#fff 55%,#eff6ff)" },
  purple: { fg: "#7c3aed", soft: "#ede9fe", chipBg: "#fee2e2", chipFg: "#b91c1c", grad: "linear-gradient(160deg,#fff 55%,#f5f3ff)" },
  orange: { fg: "#ea580c", soft: "#ffedd5", chipBg: "#dcfce7", chipFg: "#15803d", grad: "linear-gradient(160deg,#fff 55%,#fff7ed)" },
};

function smoothPath(vals: number[], w: number, h: number, pad = 4) {
  const max = Math.max(1, ...vals);
  const pts = vals.map((v, i) => [
    pad + (i / Math.max(1, vals.length - 1)) * (w - 2 * pad),
    h - pad - (v / max) * (h - 2 * pad - 6),
  ]);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const cx = (x0 + x1) / 2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  return { d, last: pts[pts.length - 1], first: pts[0] };
}

function Bars({ vals, color }: { vals: number[]; color: string }) {
  const v = vals.slice(-14);
  const max = Math.max(1, ...v);
  return (
    <div className="flex items-end gap-[3px] h-12 w-full">
      {v.map((x, i) => (
        <div
          key={i}
          className="kpi-bar flex-1 rounded-t-[3px]"
          style={{
            height: `${Math.max(8, (x / max) * 100)}%`,
            background: color,
            opacity: 0.25 + 0.75 * (i / Math.max(1, v.length - 1)),
            animationDelay: `${i * 45}ms`,
          }}
        />
      ))}
    </div>
  );
}

function Line({ vals, color, id }: { vals: number[]; color: string; id: string }) {
  const W = 200, H = 52;
  if (vals.length < 2) return <div className="h-12" />;
  const { d, last } = smoothPath(vals, W, H);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-12 overflow-visible" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.22" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path className="kpi-fade" d={`${d} L${last[0]},${H} L4,${H} Z`} fill={`url(#${id})`} />
      <path className="kpi-draw" d={d} pathLength={1} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <circle className="kpi-pulse" cx={last[0]} cy={last[1]} r="3.5" fill="#fff" stroke={color} strokeWidth="2" />
    </svg>
  );
}

function Chip({ tone, up, children }: { tone: Tone; up?: boolean; children: React.ReactNode }) {
  const Arrow = up ? HiOutlineArrowUp : HiOutlineArrowDown;
  return (
    <span className="inline-flex items-center gap-0.5 rounded-lg px-2 py-1 text-xs font-bold whitespace-nowrap" style={{ background: tone.chipBg, color: tone.chipFg }}>
      <Arrow size={12} strokeWidth={2.5} />
      {children}
    </span>
  );
}

function Card({
  tone,
  icon: Icon,
  title,
  subtitle,
  value,
  chip,
  chipNote,
  chart,
  footer,
  href,
  delay,
}: {
  tone: Tone;
  icon: React.ElementType;
  title: string;
  subtitle: string;
  value: string;
  chip?: React.ReactNode;
  chipNote?: string;
  chart: React.ReactNode;
  footer: string;
  href: string;
  delay: number;
}) {
  return (
    <div
      className="kpi-card group rounded-2xl border border-white/80 p-4 min-w-0 flex flex-col gap-3"
      style={{ background: tone.grad, animationDelay: `${delay}ms`, boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -12px rgba(16,24,40,.12)" }}
    >
      <div className="flex items-start gap-3">
        <span className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 transition-transform group-hover:scale-110" style={{ background: tone.soft, color: tone.fg }}>
          <Icon size={22} />
        </span>
        <div className="min-w-0">
          <div className="font-bold text-gray-900 text-sm leading-tight">{title}</div>
          <div className="text-xs text-gray-600 truncate">{subtitle}</div>
        </div>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="text-4xl font-extrabold text-gray-900 tabular-nums leading-none">{value}</div>
        {chip && (
          <div className="flex flex-col items-end gap-0.5">
            {chip}
            {chipNote && <span className="text-[11px] text-gray-600 whitespace-nowrap">{chipNote}</span>}
          </div>
        )}
      </div>
      <div className="min-h-12">{chart}</div>
      <Link
        href={href}
        className="flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition-colors hover:brightness-95"
        style={{ background: tone.soft, color: tone.fg }}
      >
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tone.fg }} />
        <span className="truncate">{footer}</span>
        <HiOutlineChevronRight size={14} className="ml-auto shrink-0" />
      </Link>
    </div>
  );
}

function NoiseCard({ d, delay }: { d: KpiData; delay: number }) {
  const pct = d.noise ?? 0;
  const shown = useCountUp(pct, 1);
  const grade = pct >= 90 ? "Excellent" : pct >= 70 ? "Good" : "Fair";
  const r = 15.9155;
  const times = d.incidents ? Math.round(d.raw / d.incidents) : 0;
  return (
    <div
      className="kpi-card sm:col-span-2 min-[1700px]:col-span-1 rounded-2xl border border-green-100 p-4 min-w-0 flex flex-col gap-3"
      style={{ background: "linear-gradient(160deg,#fff 40%,#ecfdf5)", animationDelay: `${delay}ms`, boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -12px rgba(22,163,74,.25)" }}
    >
      <div className="flex items-start gap-3">
        <span className="w-11 h-11 rounded-xl bg-green-100 text-green-700 flex items-center justify-center shrink-0">
          <LuLeaf size={22} />
        </span>
        <div className="min-w-0">
          <div className="font-bold text-gray-900 text-sm leading-tight">Noise reduction</div>
          <div className="text-xs text-gray-600">From alerts to incidents</div>
        </div>
        <span className="ml-auto inline-flex items-center gap-1 rounded-lg bg-green-100 text-green-800 text-xs font-bold px-2 py-1 shrink-0">
          <HiOutlineSparkles size={12} />
          {grade}
        </span>
      </div>
      <div className="flex items-center gap-4">
        <div className="relative w-28 h-28 shrink-0">
          <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
            <circle cx="18" cy="18" r={r} fill="none" stroke="#d1fae5" strokeWidth="4.5" />
            <circle
              className="kpi-ring"
              cx="18"
              cy="18"
              r={r}
              fill="none"
              stroke="#16a34a"
              strokeWidth="4.5"
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray={`${pct} ${100 - pct}`}
              style={{ ["--ring" as string]: pct }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center text-xl font-extrabold text-gray-900 tabular-nums">
            {d.noise === null ? "—" : `${shown}%`}
          </div>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-gray-900">
            <span><b className="text-lg tabular-nums">{d.raw.toLocaleString()}</b><span className="block text-[11px] text-gray-600">Raw alerts</span></span>
            <span className="text-gray-500">→</span>
            <span><b className="text-lg tabular-nums">{d.incidents}</b><span className="block text-[11px] text-gray-600">Incidents</span></span>
          </div>
          {times > 1 && <div className="mt-2 text-sm font-bold text-green-700">{times}× less noise</div>}
        </div>
        {/* Only shown when the card spans two columns; fills the wide layout with the reduction steps. */}
        <div className="hidden sm:flex flex-1 min-w-0 flex-col gap-2 pl-4 ml-2 border-l border-green-100 min-[1700px]:hidden">
          {[
            { label: "Raw alerts", v: d.raw, c: "#bbf7d0" },
            { label: "After dedup", v: d.unique, c: "#86efac" },
            { label: "In incidents", v: d.correlated, c: "#22c55e" },
            { label: "Incidents", v: d.incidents, c: "#15803d" },
          ].map((r, i) => (
            <div key={r.label} className="flex items-center gap-3 text-xs">
              <span className="w-20 shrink-0 text-gray-600">{r.label}</span>
              <div className="flex-1 h-2.5 rounded-full bg-green-50 overflow-hidden">
                <div
                  className="kpi-hbar h-full rounded-full"
                  style={{ width: `${Math.max(3, (Math.sqrt(r.v) / Math.sqrt(Math.max(1, d.raw))) * 100)}%`, background: r.c, animationDelay: `${400 + i * 120}ms` }}
                />
              </div>
              <b className="w-14 text-right tabular-nums text-gray-900">{r.v.toLocaleString()}</b>
            </div>
          ))}
          <div className="text-[11px] text-gray-500">Bar lengths use a square-root scale so small stages stay visible.</div>
        </div>
      </div>
      <Link href="/deduplication" className="flex items-center gap-2 rounded-xl bg-green-100 text-green-800 px-3 py-2 text-xs font-semibold hover:brightness-95">
        <LuChartNoAxesColumn size={14} className="shrink-0" />
        <span className="truncate">Cleaner alerts. Happier on-calls.</span>
        <HiOutlineChevronRight size={14} className="ml-auto shrink-0" />
      </Link>
    </div>
  );
}

export function KpiCards({ d }: { d: KpiData }) {
  const raw = useCountUp(d.raw);
  const uniq = useCountUp(d.unique);
  const corr = useCountUp(d.correlated);
  const inc = useCountUp(d.incidents);
  const removedPct = d.raw ? Math.round(100 * (1 - d.unique / d.raw)) : 0;
  const corrPct = d.unique ? Math.round(100 * (d.correlated / d.unique)) : 0;
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div ref={ref} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 min-[1700px]:grid-cols-[1fr_1fr_1fr_1fr_1.35fr] gap-3">
      <Card
        tone={TONES.red}
        icon={HiOutlineBell}
        title="Raw alerts"
        subtitle="Total incoming signals"
        value={raw}
        chip={d.peak > 0 ? <Chip tone={{ ...TONES.red }} up>{d.peak} peak</Chip> : undefined}
        chipNote={d.peakLabel ? `at ${d.peakLabel}` : undefined}
        chart={<Bars vals={d.totalSeries} color="#ef4444" />}
        footer={`Busiest bucket: ${d.peak} alerts`}
        href="/alerts/feed"
        delay={0}
      />
      <Card
        tone={TONES.blue}
        icon={HiOutlineShare}
        title="Unique signals"
        subtitle="After deduplication"
        value={uniq}
        chip={<Chip tone={TONES.blue}>{removedPct}%</Chip>}
        chipNote="vs. raw alerts"
        chart={<Line vals={d.totalSeries} color="#2563eb" id="kpi-blue" />}
        footer={`${(d.raw - d.unique).toLocaleString()} duplicates filtered`}
        href="/deduplication"
        delay={80}
      />
      <Card
        tone={TONES.purple}
        icon={HiOutlineRectangleStack}
        title="Correlated signals"
        subtitle="Clustered into incidents"
        value={corr}
        chip={<Chip tone={{ ...TONES.purple, chipBg: "#ede9fe", chipFg: "#6d28d9" }} up>{corrPct}%</Chip>}
        chipNote="of unique signals"
        chart={<Bars vals={d.correlatedSeries} color="#8b5cf6" />}
        footer="Signals grouped intelligently"
        href="/correlations"
        delay={160}
      />
      <Card
        tone={TONES.orange}
        icon={HiOutlineViewfinderCircle}
        title="Actionable incidents"
        subtitle="Needs engineer attention"
        value={inc}
        chip={<Chip tone={{ ...TONES.orange, chipBg: "#ffedd5", chipFg: "#c2410c" }} up>{d.p1} P1</Chip>}
        chipNote="highest priority"
        chart={<Line vals={d.incidentSeries} color="#f97316" id="kpi-orange" />}
        footer="Ready for investigation"
        href="/incidents"
        delay={240}
      />
      <NoiseCard d={d} delay={320} />
    </div>
  );
}
