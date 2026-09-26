"use client";

/** Half-ring gauge. `fraction` is 0-1; `display` is the number printed in the
 * middle, so the same component serves Impact (0-100) and Confidence (0-1). */
export function Gauge({
  fraction,
  display,
  label,
  caption,
  color,
}: {
  fraction: number;
  display: string;
  label: string;
  caption?: string;
  color: string;
}) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <figure className="flex flex-col items-center min-w-0" aria-label={`${label}: ${display}`}>
      <svg viewBox="0 0 100 58" className="w-full max-w-[150px]" aria-hidden>
        <path d="M 8 52 A 42 42 0 0 1 92 52" fill="none" stroke="#e5e7eb" strokeWidth="9" strokeLinecap="round" pathLength={100} />
        <path
          className="gauge-arc"
          d="M 8 52 A 42 42 0 0 1 92 52"
          fill="none"
          stroke={color}
          strokeWidth="9"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${pct} 100`}
        />
        <text x="50" y="47" textAnchor="middle" className="fill-gray-900" style={{ fontSize: 19, fontWeight: 800 }}>
          {display}
        </text>
      </svg>
      <figcaption className="text-center -mt-0.5">
        <div className="text-[10.5px] font-bold uppercase tracking-wider text-gray-600">{label}</div>
        {caption && <div className="text-[10.5px] text-gray-500 leading-tight">{caption}</div>}
      </figcaption>
    </figure>
  );
}
