import Link from "next/link";
import { AlertLensMark } from "@/components/AlertLensMark";

/** Logo + tagline pinned at the top of the sidebar, above the nav list. */
export const SidebarHeader = () => (
  <Link
    href="/"
    className="flex items-center gap-3 px-3 pt-4 pb-3 group"
    data-testid="sidebar-logo"
  >
    <span className="flex items-center justify-center w-10 h-10 shrink-0 rounded-xl bg-gradient-to-br from-green-50 to-green-100 ring-1 ring-green-200/70 shadow-sm transition-transform duration-200 group-hover:scale-105">
      <AlertLensMark className="w-6 h-6" />
    </span>
    <div className="min-w-0">
      <div className="text-[16px] font-extrabold tracking-tight leading-tight truncate bg-gradient-to-r from-green-800 to-green-500 bg-clip-text text-transparent">
        Nexus AIOps
      </div>
      <div className="text-[11px] text-gray-400 leading-tight truncate">
        Signals to reviewed tickets
      </div>
    </div>
  </Link>
);
