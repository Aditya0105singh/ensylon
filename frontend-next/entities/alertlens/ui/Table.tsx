"use client";

import clsx from "clsx";

/**
 * Small table primitives shared by the AlertLens pages that render their own
 * tables rather than the TanStack-backed GenericTable (Home's recent alerts,
 * the Correlations raw stream, Evaluation's per-seed results).
 *
 * These existed as three hand-rolled copies that had drifted apart on hover,
 * padding and last-row borders. Styling lives here so they stay in step; the
 * columns themselves stay in the pages, since they have nothing in common.
 */

export function DataTable({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <table className={clsx("w-full text-sm", className)}>{children}</table>;
}

export function TableHead({
  children,
  /** Keeps headers visible while the body scrolls inside a fixed-height card. */
  sticky = false,
}: {
  children: React.ReactNode;
  sticky?: boolean;
}) {
  return (
    <thead className={clsx(sticky && "sticky top-0 bg-tremor-background z-10")}>
      <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
        {children}
      </tr>
    </thead>
  );
}

export function Th({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <th className={clsx("py-2 px-3 font-medium", className)}>{children}</th>;
}

export function Tr({
  children,
  onClick,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const clickable = Boolean(onClick);
  return (
    <tr
      onClick={onClick}
      // Hover feedback is only applied to rows that actually do something —
      // showing it on a static row implies an interaction that isn't there.
      className={clsx(
        "border-b border-gray-100 last:border-0",
        clickable &&
          "cursor-pointer transition-colors duration-150 hover:bg-gray-50",
        className
      )}
    >
      {children}
    </tr>
  );
}

export function Td({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <td className={clsx("py-2 px-3", className)}>{children}</td>;
}
