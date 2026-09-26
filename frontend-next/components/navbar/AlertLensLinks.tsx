"use client";

import { Subtitle } from "@tremor/react";
import { LinkWithIcon } from "components/LinkWithIcon";
import { useEngineQueue } from "@/entities/engine/useEngine";
import { Disclosure } from "@headlessui/react";
import { IoChevronUp } from "react-icons/io5";
import { IconType } from "react-icons/lib";
import clsx from "clsx";
import { IoMdGitMerge } from "react-icons/io";
import { TbTopologyRing, TbTimeline, TbChartDots3, TbHistory } from "react-icons/tb";
import { LuWorkflow, LuGauge, LuBrainCircuit } from "react-icons/lu";
import { VscDebugDisconnect } from "react-icons/vsc";
import {
  AiOutlineAlert,
  AiOutlineFire,
  AiOutlineGroup,
  AiOutlineHome,
} from "react-icons/ai";
import {
  MdOutlineNotificationsActive,
  MdOutlineRuleFolder,
  MdOutlineEventBusy,
} from "react-icons/md";
import {
  HiOutlineCog6Tooth,
  HiOutlineSparkles,
  HiOutlineShieldCheck,
} from "react-icons/hi2";

type NavLink = {
  href: string;
  label: string;
  icon: IconType;
  testId: string;
  isExact?: boolean;
  isDemo?: boolean;
};

type NavSection = {
  title: string;
  links: NavLink[];
};

// Header-less group at the top: Overview + the live signal feed.
const TOP_LINKS: NavLink[] = [
  { href: "/", label: "Overview", icon: AiOutlineHome, testId: "home", isExact: true },
  { href: "/feed", label: "Live Signals", icon: AiOutlineAlert, testId: "feed" },
];

// Every page here reads the live engine (/engine/*). Surfaces that relied on
// sample data or on the pre-challenge batch pipeline are not linked: the three
// Nexus streams are the only input.
const SECTIONS: NavSection[] = [
  {
    title: "INCIDENT INTELLIGENCE",
    links: [
      { href: "/review", label: "Incidents & Review", icon: HiOutlineShieldCheck, testId: "review" },
      { href: "/correlations", label: "Correlation & Validation", icon: TbChartDots3, testId: "correlations" },
      { href: "/topology", label: "Service Topology", icon: TbTopologyRing, testId: "topology" },
    ],
  },
  {
    title: "ANALYSIS",
    links: [
      { href: "/history", label: "Incident History", icon: TbHistory, testId: "history" },
      { href: "/timemachine", label: "Time Machine", icon: TbTimeline, testId: "timemachine" },
      { href: "/deduplication", label: "Deduplication", icon: IoMdGitMerge, testId: "deduplication" },
      { href: "/evaluation", label: "Evaluation", icon: LuBrainCircuit, testId: "evaluation" },
    ],
  },
  {
    title: "SYSTEM",
    links: [
      { href: "/settings", label: "Settings", icon: HiOutlineCog6Tooth, testId: "settings" },
    ],
  },
];

const NavGroup = ({
  title,
  links,
  counts,
}: NavSection & { counts: Record<string, number> }) => (
  <Disclosure as="div" className="space-y-0.5" defaultOpen>
    <Disclosure.Button className="w-full flex items-center gap-2 px-3 pt-1 group/head">
      {({ open }) => (
        <>
          <Subtitle className="text-[10.5px] text-gray-400 font-semibold uppercase tracking-wider group-hover/head:text-green-700 transition-colors">
            {title}
          </Subtitle>
          <span aria-hidden="true" className="h-px flex-1 bg-gray-200/80" />
          <IoChevronUp
            className={clsx(
              { "rotate-180": open },
              "text-gray-300 w-3 h-3 transition-transform duration-200"
            )}
          />
        </>
      )}
    </Disclosure.Button>
    <Disclosure.Panel as="ul" className="space-y-0.5 p-1 pr-1">
      {links.map((link) => (
        <li key={link.href}>
          <LinkWithIcon
            href={link.href}
            icon={link.icon}
            testId={link.testId}
            isExact={link.isExact}
            isBeta={link.isDemo}
            count={counts[link.href] > 0 ? counts[link.href] : undefined}
          >
            <Subtitle className="text-xs">{link.label}</Subtitle>
          </LinkWithIcon>
        </li>
      ))}
    </Disclosure.Panel>
  </Disclosure>
);

export const AlertLensLinks = () => {
  // The one live number worth surfacing in the nav: drafts waiting on a human.
  const { data: queue } = useEngineQueue();
  const counts = {
    "/review": (queue ?? []).filter((q) => q.status === "awaiting_review").length,
  };

  return (
    <>
      <ul className="space-y-0.5 p-1 pr-1">
        {TOP_LINKS.map((link) => (
          <li key={link.href}>
            <LinkWithIcon href={link.href} icon={link.icon} testId={link.testId} isExact={link.isExact}>
              <Subtitle className="text-xs">{link.label}</Subtitle>
            </LinkWithIcon>
          </li>
        ))}
      </ul>
      {SECTIONS.map((section) => (
        <NavGroup key={section.title} {...section} counts={counts} />
      ))}
    </>
  );
};
