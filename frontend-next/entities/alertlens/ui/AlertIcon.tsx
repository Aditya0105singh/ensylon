"use client";

import {
  SiApachekafka,
  SiDatadog,
  SiGooglecloud,
  SiGrafana,
  SiKubernetes,
  SiPostgresql,
  SiPrometheus,
  SiRedis,
} from "react-icons/si";
import {
  LuActivity,
  LuBell,
  LuClock,
  LuCpu,
  LuDatabase,
  LuFileBadge,
  LuFileText,
  LuFlame,
  LuGlobe,
  LuHardDrive,
  LuLayers,
  LuLock,
  LuPackage,
  LuPlug,
  LuShieldCheck,
  LuUser,
} from "react-icons/lu";
import type { IconType } from "react-icons";
import clsx from "clsx";

/**
 * Real brand marks for infrastructure that actually has one — the Postgres
 * elephant, the Kafka mark, the Redis logo. Purely generic services
 * (api-gateway, checkout-service, worker-node-3, …) have no real-world logo,
 * so they fall back to a concept icon derived from the alert name.
 */
const TECH_RULES: [string, IconType, string][] = [
  ["postgres", SiPostgresql, "#336791"],
  ["kafka", SiApachekafka, "#231F20"],
  ["redis", SiRedis, "#DC382D"],
  ["k8s", SiKubernetes, "#326CE5"],
  ["kube", SiKubernetes, "#326CE5"],
];

export function techLogoFor(service?: string) {
  if (!service) return null;
  const s = service.toLowerCase();
  const match = TECH_RULES.find(([k]) => s.includes(k));
  return match ? { Icon: match[1], color: match[2] } : null;
}

/** Brand marks for the monitoring sources alerts arrive from. */
export const SOURCE_LOGO: Record<string, { Icon: IconType; color: string }> = {
  prometheus: { Icon: SiPrometheus, color: "#E6522C" },
  datadog: { Icon: SiDatadog, color: "#632CA6" },
  grafana: { Icon: SiGrafana, color: "#F46800" },
  "gcp-monitoring": { Icon: SiGooglecloud, color: "#4285F4" },
};

/** Concept icons keyed by a substring of the alert name. */
const ICON_RULES: [string, IconType][] = [
  ["Queue", LuLayers],
  ["Latency", LuActivity],
  ["Timeout", LuClock],
  ["Connection", LuPlug],
  ["ErrorRate", LuFlame],
  ["Login", LuUser],
  ["Token", LuShieldCheck],
  ["Auth", LuLock],
  ["Memory", LuCpu],
  ["Disk", LuHardDrive],
  ["CPU", LuCpu],
  ["Pod", LuPackage],
  ["DNS", LuGlobe],
  ["Log", LuFileText],
  ["Session", LuClock],
  ["Cert", LuFileBadge],
  ["DB", LuDatabase],
];

const SEVERITY_CLASS: Record<string, string> = {
  critical: "bg-red-50 border-red-200 text-red-500",
  high: "bg-orange-50 border-orange-200 text-orange-500",
  medium: "bg-yellow-50 border-yellow-200 text-yellow-600",
  low: "bg-green-50 border-green-200 text-green-600",
  info: "bg-blue-50 border-blue-200 text-blue-500",
};

export function AlertIcon({
  alertname,
  severity,
  service,
  className,
}: {
  alertname?: string;
  severity?: string;
  service?: string;
  className?: string;
}) {
  const tech = techLogoFor(service);

  if (tech) {
    const { Icon, color } = tech;
    return (
      <span
        title={service}
        className={clsx(
          "w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border bg-white",
          className
        )}
        style={{ borderColor: `${color}59` }}
      >
        <Icon size={16} color={color} />
      </span>
    );
  }

  const Icon =
    ICON_RULES.find(([k]) => alertname?.includes(k))?.[1] ?? LuBell;

  return (
    <span
      title={service}
      className={clsx(
        "w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border",
        SEVERITY_CLASS[severity ?? ""] ?? "bg-gray-50 border-gray-200 text-gray-500",
        className
      )}
    >
      <Icon size={16} />
    </span>
  );
}

/** Source name with its brand mark, for feed rows and the alert drawer. */
export function SourceTag({ source }: { source?: string }) {
  if (!source) return null;
  const logo = SOURCE_LOGO[source];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
      {logo && <logo.Icon size={12} color={logo.color} />}
      {source}
    </span>
  );
}

/** Service name with its brand mark, where one exists. */
export function ServiceChip({ service }: { service?: string }) {
  if (!service) return null;
  const tech = techLogoFor(service);
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      {tech && <tech.Icon size={13} color={tech.color} className="shrink-0" />}
      <span className="truncate">{service}</span>
    </span>
  );
}
