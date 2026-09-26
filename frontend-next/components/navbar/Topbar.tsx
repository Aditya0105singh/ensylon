"use client";

import Link from "next/link";
import { Session } from "next-auth";
import { HiOutlineBell, HiOutlineCheckCircle } from "react-icons/hi2";
import { Search } from "@/components/navbar/Search";
import { UserInfo } from "@/components/navbar/UserInfo";
import { useEngineQueue, useStreamStatus } from "@/entities/engine/useEngine";

/**
 * Horizontal bar above the page content: search, real pipeline-health status,
 * a real notification count, and the user menu. Only spans the main content
 * column - the sidebar (logo + nav) lives to its left, unaffected.
 */
export function Topbar({ session }: { session: Session | null }) {
  const { data: status } = useStreamStatus();
  const { data: queue } = useEngineQueue();

  // A real read on the live streams, not a decoration: how many of the three
  // SSE connections are up right now. Anything else is reported as it is.
  const total = status?.streams.length ?? 0;
  const up = status?.streams.filter((s) => s.connected).length ?? 0;
  const healthy = total > 0 && up === total;
  // A replay is never reported as live.
  const replaying = !!status?.replay?.active;
  // The bell counts drafts waiting for a human decision: the one number an
  // on-call reviewer actually needs, and it clears itself as they are decided.
  const bellCount = (queue ?? []).filter((q) => q.status === "awaiting_review").length;

  return (
    // .page-container pads its scroll area by 16px (24px on xl), so a plain
    // `sticky top-0` sticks below that padding and page content shows through
    // the strip above the bar. The negative margin/top pull the bar up over
    // that padding so it sits flush with the top of the scroll area.
    // Solid bg-gray-50 (the page's own background) so nothing scrolling
    // underneath can show through; the gradient below fades content out
    // instead of cutting it off at the bar's edge.
    <div className="flex items-center gap-3 px-4 pb-3 pt-3 -mt-4 xl:-mt-6 -top-4 xl:-top-6 bg-gray-50 sticky z-20">
      <div className="flex-1 min-w-0 max-w-xl">
        <Search />
      </div>

      <div className="flex items-center gap-2.5 ml-auto">
        <Link
          href="/settings"
          className={`hidden sm:inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-shadow hover:shadow-md ${replaying ? "border-amber-300" : healthy ? "border-green-200" : "border-gray-200"}`}
          style={
            replaying
              ? { background: "#fffbeb", color: "#92400e", boxShadow: "0 1px 2px rgba(146,64,14,0.10)" }
              : healthy
              ? {
                  background: "linear-gradient(135deg,#f0fdf4,#dcfce7)",
                  color: "#15803d",
                  boxShadow: "0 1px 2px rgba(21,128,61,0.10)",
                }
              : {
                  background: "#ffffff",
                  color: "#6b7280",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                }
          }
        >
          <span className="relative flex w-2 h-2">
            {healthy && !replaying && (
              <span
                className="absolute inline-flex w-full h-full rounded-full opacity-60 animate-ping"
                style={{ background: "#22c55e" }}
              />
            )}
            <span
              className="relative inline-flex w-2 h-2 rounded-full"
              style={{ background: replaying ? "#f59e0b" : healthy ? "#22c55e" : "#9ca3af" }}
            />
          </span>
          {!status ? "Backend offline" : replaying ? "Replay · not live" : healthy ? `Streams live ${up}/${total}` : `Streams ${up}/${total} connected`}
        </Link>

        <Link
          href="/review#review-queue"
          scroll={false}
          className="relative flex items-center justify-center w-10 h-10 rounded-full border border-gray-200 bg-white text-gray-500 shadow-sm hover:shadow-md hover:text-green-700 hover:border-green-200 transition-all"
          title={`${bellCount} incident draft(s) awaiting human review`}
        >
          <HiOutlineBell size={18} />
          {bellCount > 0 && (
            <span
              className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center text-white ring-2 ring-gray-50"
              style={{ background: "#15803d" }}
            >
              {bellCount > 99 ? "99+" : bellCount}
            </span>
          )}
        </Link>

        <UserInfo session={session} inline />
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-full h-5 bg-gradient-to-b from-gray-50 to-transparent"
      />
    </div>
  );
}
