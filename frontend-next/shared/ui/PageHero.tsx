import clsx from "clsx";

/** Gradient banner used at the top of every AlertLens page: icon tile, title,
 * subtitle, and an optional right-hand slot for controls or badges. */
export function PageHero({
  icon: Icon,
  title,
  subtitle,
  eyebrow,
  children,
  className,
}: {
  icon?: React.ElementType;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  eyebrow?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "kpi-card relative overflow-hidden rounded-2xl border border-green-100 px-5 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4",
        className
      )}
      style={{
        background: "linear-gradient(120deg,#f0fdf4 0%,#ffffff 55%,#ecfdf5 100%)",
        boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -12px rgba(22,163,74,.25)",
      }}
    >
      <div aria-hidden className="pointer-events-none absolute -right-10 -top-16 w-56 h-56 rounded-full bg-green-200/40 blur-3xl" />
      <div className="relative flex items-center gap-3.5 min-w-0">
        {Icon && (
          <span className="kpi-pop w-12 h-12 rounded-2xl bg-green-100 text-green-700 flex items-center justify-center shrink-0">
            <Icon size={24} />
          </span>
        )}
        <div className="min-w-0">
          {eyebrow && <div className="text-xs text-gray-600 mb-0.5">{eyebrow}</div>}
          <h1 className="text-2xl font-extrabold tracking-tight text-gray-900 break-words leading-tight">{title}</h1>
          {subtitle && <p className="text-sm text-gray-700 mt-1 max-w-3xl">{subtitle}</p>}
        </div>
      </div>
      {children && <div className="relative flex items-center gap-2 flex-wrap md:justify-end shrink-0">{children}</div>}
    </div>
  );
}
