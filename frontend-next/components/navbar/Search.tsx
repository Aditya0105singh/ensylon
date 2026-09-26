"use client";

import { ElementRef, Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Combobox,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
  Transition,
} from "@headlessui/react";
import { UserGroupIcon } from "@heroicons/react/24/outline";
import { HiOutlineMagnifyingGlass } from "react-icons/hi2";
import { LuWorkflow, LuGauge, LuBrainCircuit } from "react-icons/lu";
import { AiOutlineAlert } from "react-icons/ai";
import {
  MdOutlineSearchOff,
  MdOutlineNotificationsActive,
} from "react-icons/md";
import { IoMdGitMerge } from "react-icons/io";
import { TbTopologyRing, TbTimeline, TbChartDots3 } from "react-icons/tb";
import { AlertLensMark } from "@/components/AlertLensMark";

const NAVIGATION_OPTIONS = [
  { icon: AiOutlineAlert, label: "Go to signal feed", shortcut: ["f"], navigate: "/feed" },
  { icon: MdOutlineNotificationsActive, label: "Go to incidents & review", shortcut: ["i"], navigate: "/review" },
  { icon: TbTimeline, label: "Go to time machine", shortcut: ["m"], navigate: "/timemachine" },
  { icon: IoMdGitMerge, label: "Go to deduplication", shortcut: ["d"], navigate: "/deduplication" },
  { icon: TbChartDots3, label: "Go to correlation & validation", shortcut: ["c"], navigate: "/correlations" },
  { icon: TbTopologyRing, label: "Go to service topology", shortcut: ["t"], navigate: "/topology" },
  { icon: LuBrainCircuit, label: "Go to evaluation", shortcut: ["e"], navigate: "/evaluation" },
  { icon: UserGroupIcon, label: "Go to settings", shortcut: ["s"], navigate: "/settings" },
];

function ResultRow({
  option,
  active,
}: {
  option: (typeof NAVIGATION_OPTIONS)[number];
  active: boolean;
}) {
  // Colours are classes, not inline styles, so dark mode's border and surface
  // overrides can reach them.
  return (
    <div
      className={`flex items-center gap-3 cursor-default select-none rounded-xl px-2.5 py-2 transition-colors duration-100 ${
        active ? "bg-green-50" : ""
      }`}
    >
      <span
        className={`flex items-center justify-center w-8 h-8 rounded-lg shrink-0 transition-colors duration-100 ${
          active ? "bg-green-700 text-white" : "bg-gray-100 text-gray-600"
        }`}
      >
        <option.icon size={15} />
      </span>
      <span
        className={`text-sm font-medium text-left flex-1 truncate ${
          active ? "text-green-900" : "text-gray-800"
        }`}
      >
        {option.label}
      </span>
      <span className="hidden sm:flex items-center gap-0.5">
        {option.shortcut.map((k) => (
          <kbd
            key={k}
            className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              active
                ? "border-green-200 bg-green-100 text-green-700"
                : "border-gray-300 bg-gray-50 text-gray-400"
            }`}
          >
            {k}
          </kbd>
        ))}
      </span>
    </div>
  );
}

export const Search = () => {
  const [query, setQuery] = useState<string>("");
  const [isFocused, setIsFocused] = useState(false);
  const router = useRouter();
  const comboboxInputRef = useRef<ElementRef<"input">>(null);
  const OPTIONS = NAVIGATION_OPTIONS;

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (comboboxInputRef.current) {
          comboboxInputRef.current.focus();
        }
      }
    };

    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const onOptionSelection = (value: string | null) => {
    if (value && comboboxInputRef.current) {
      comboboxInputRef.current.blur();
      router.push(value);
    }
  };

  const onLeave = () => {
    setQuery("");

    if (comboboxInputRef.current) {
      comboboxInputRef.current.blur();
    }
  };

  const queriedOptions = query.length
    ? OPTIONS.filter((option) =>
        option.label
          .toLowerCase()
          .replace(/\s+/g, "")
          .includes(query.toLowerCase().replace(/\s+/g, ""))
      )
    : OPTIONS;

  const isMac = () => {
    const platform = navigator.platform.toLowerCase();
    const userAgent = navigator.userAgent.toLowerCase();
    return (
      platform.includes("mac") ||
      (platform.includes("iphone") && !userAgent.includes("windows"))
    );
  };

  const [shortcutLabel, setShortcutLabel] = useState("Ctrl K");

  // Using effect to avoid mismatch on hydration. TODO: context provider for user agent
  useEffect(function updateShortcutLabel() {
    if (isMac()) setShortcutLabel("⌘K");
  }, []);

  return (
    <div className="flex items-center w-full gap-1">
      <div className="flex-shrink-0 flex items-center">
        <Link href="/" aria-label="Nexus AIOps home" className="flex items-center">
          <AlertLensMark className="w-8 h-8" />
        </Link>
      </div>

      <div className="flex-grow ml-4">
        <Combobox
          value={query}
          onChange={onOptionSelection}
          as="div"
          className="relative w-full"
          immediate
        >
          {({ open }) => (
            <>
              {open && (
                <div
                  className="fixed inset-0 bg-gray-900/20 backdrop-blur-[1px] z-10"
                  aria-hidden="true"
                />
              )}

              <div
                className={`relative z-20 flex items-center w-full rounded-2xl border bg-white transition-all duration-150 ${
                  isFocused ? "" : "border-gray-300"
                }`}
                style={
                  isFocused
                    ? {
                        borderColor: "#6ee7b7",
                        boxShadow: "0 0 0 4px rgba(16,185,129,0.14), 0 2px 8px rgba(0,0,0,0.04)",
                      }
                    : { boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }
                }
              >
                <HiOutlineMagnifyingGlass
                  size={17}
                  className="ml-3.5 shrink-0"
                  style={{ color: isFocused ? "#15803d" : "#9ca3af" }}
                />
                <ComboboxInput
                  className="peer flex-1 min-w-0 bg-transparent border-0 outline-none focus:outline-none focus:ring-0 text-sm text-gray-800 placeholder:text-gray-400 py-2.5 px-2.5"
                  placeholder="Search or jump to a page..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onFocus={() => setIsFocused(true)}
                  onBlur={() => setIsFocused(false)}
                  ref={comboboxInputRef}
                />
                {!query.length && (
                  <kbd
                    className="hidden sm:inline-flex mr-2.5 shrink-0 items-center rounded-lg border border-gray-300 px-1.5 py-1 text-[10px] font-semibold tracking-wide text-gray-400 bg-gray-50"
                  >
                    {shortcutLabel}
                  </kbd>
                )}
              </div>

              <Transition
                as={Fragment}
                enter="transition ease-out duration-100"
                enterFrom="opacity-0 scale-95 -translate-y-1"
                enterTo="opacity-100 scale-100 translate-y-0"
                leave="transition ease-in duration-75"
                leaveFrom="opacity-100 scale-100"
                leaveTo="opacity-0 scale-95"
                beforeLeave={onLeave}
              >
                <ComboboxOptions
                  className="absolute mt-2 max-h-[70vh] overflow-auto rounded-2xl bg-white p-2 shadow-xl ring-1 ring-black/5 focus:outline-none z-20 w-full sm:w-96 origin-top"
                >
                  {query.length > 0 && queriedOptions.length === 0 && (
                    <div className="flex flex-col items-center justify-center gap-2 py-12 text-gray-400">
                      <span
                        className="flex items-center justify-center w-10 h-10 rounded-full"
                        style={{ background: "#f3f4f6" }}
                      >
                        <MdOutlineSearchOff size={20} />
                      </span>
                      <span className="text-sm">Nothing matches &ldquo;{query}&rdquo;</span>
                    </div>
                  )}

                  {!!queriedOptions.length && (
                    <>
                      <div className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                        {query.length ? "Matching pages" : "Navigate"}
                      </div>
                      <div className="flex flex-col gap-0.5">
                        {queriedOptions.map((option) => (
                          <ComboboxOption
                            key={option.label}
                            as={Fragment}
                            value={option.navigate}
                          >
                            {({ active }) => (
                              <ResultRow option={option} active={active} />
                            )}
                          </ComboboxOption>
                        ))}
                      </div>
                    </>
                  )}
                </ComboboxOptions>
              </Transition>
            </>
          )}
        </Combobox>
      </div>
    </div>
  );
};
