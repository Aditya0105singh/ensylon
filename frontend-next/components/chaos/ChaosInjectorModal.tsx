"use client";

import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { Badge, Button, Text } from "@tremor/react";
import { IoFlash, IoClose, IoWarningOutline } from "react-icons/io5";

interface ChaosInjectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the chosen scenario key. The parent drives the actual fetch + replay. */
  onInject?: (scenarioId: string) => void;
}

const SCENARIOS = [
  {
    id: "db_connection_exhaustion",
    name: "Postgres Connection Exhaustion",
    icon: "🐘",
    severity: "critical",
    description:
      "Connection pool maxed at 200/200. Downstream API gateways & order services begin timing out within 30s.",
    targetService: "postgres-primary",
  },
  {
    id: "redis_memory_pressure",
    name: "Redis Memory Pressure",
    icon: "⚡",
    severity: "critical",
    description:
      "Used memory hits 97% of maxmemory limit. Mass key eviction triggers 68% cache miss rate hammering the DB.",
    targetService: "redis-cache",
  },
  {
    id: "auth_cascade_failure",
    name: "Auth Cascade Failure",
    icon: "🔑",
    severity: "critical",
    description:
      "JWKS endpoint returning 503 — JWT validation at 96% error rate. Auth rejections spike 40× across all client apps.",
    targetService: "auth-service",
  },
  {
    id: "disk_full_logging",
    name: "Disk Full — Log Partition",
    icon: "💾",
    severity: "high",
    description:
      "/var/log partition at 98.7%. Payment workers enter CrashLoopBackOff on write failure. Kubelet flapping.",
    targetService: "worker-node-3",
  },
  {
    id: "network_packet_loss",
    name: "Network Packet Loss (ToR Switch)",
    icon: "🌐",
    severity: "high",
    description:
      "12% packet loss between AZ subnets. gRPC DEADLINE_EXCEEDED rising, Kafka ISR set shrinks on 14 partitions.",
    targetService: "network-fabric",
  },
];

export function ChaosInjectorModal({
  isOpen,
  onClose,
  onInject,
}: ChaosInjectorModalProps) {
  const handleInject = (scenarioId: string) => {
    onInject?.(scenarioId);
    onClose();
  };

  return (
    <Dialog open={isOpen} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" />

      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="mx-auto max-w-2xl w-full rounded-xl bg-slate-900 border border-slate-800 p-6 text-white shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/20 text-green-400">
                <IoFlash className="w-5 h-5" />
              </div>
              <div>
                <DialogTitle className="text-base font-bold text-slate-100 flex items-center gap-2">
                  Chaos Engineering — Fault Injector
                  <Badge color="emerald" size="xs">
                    Live Replay
                  </Badge>
                </DialogTitle>
                <Text className="text-xs text-slate-400 mt-0.5">
                  Choose an infrastructure failure to simulate a real-time alert storm with correlation replay.
                </Text>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
            >
              <IoClose className="w-5 h-5" />
            </button>
          </div>

          {/* Scenario list */}
          <div className="grid grid-cols-1 gap-2.5 my-4 max-h-[60vh] overflow-y-auto pr-1">
            {SCENARIOS.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between p-3.5 rounded-lg bg-slate-950/60 border border-slate-800/80 hover:border-green-500/50 transition group cursor-default"
              >
                <div className="flex items-start gap-3 min-w-0 pr-2">
                  <span className="text-2xl leading-none mt-0.5">{s.icon}</span>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-slate-200 text-sm">
                        {s.name}
                      </span>
                      <Badge
                        color={s.severity === "critical" ? "red" : "amber"}
                        size="xs"
                      >
                        {s.severity}
                      </Badge>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">
                      {s.description}
                    </p>
                    <span className="inline-block mt-1 text-[10px] font-mono text-slate-500">
                      Root: {s.targetService}
                    </span>
                  </div>
                </div>

                <Button
                  size="xs"
                  color="emerald"
                  onClick={() => handleInject(s.id)}
                  className="shrink-0"
                >
                  Inject 💥
                </Button>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="pt-3 border-t border-slate-800 flex items-center justify-between text-xs text-slate-500">
            <div className="flex items-center gap-1.5 text-amber-400/80">
              <IoWarningOutline className="w-4 h-4 shrink-0" />
              <span>
                Triggers deduplication → DBSCAN clustering → Alert DNA matching → Live replay.
              </span>
            </div>
            <button
              onClick={onClose}
              className="ml-4 shrink-0 text-slate-400 hover:text-slate-200 transition text-xs"
            >
              Cancel
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
