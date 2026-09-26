"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { Badge, Button } from "@tremor/react";
import { IoTerminal, IoCheckmarkCircle, IoClose } from "react-icons/io5";

interface InteractiveTerminalModalProps {
  isOpen: boolean;
  onClose: () => void;
  actionTitle: string;
  commandText?: string;
  targetService?: string;
  onCompleted?: () => void;
}

export function InteractiveTerminalModal({
  isOpen,
  onClose,
  actionTitle,
  commandText = "kubectl rollout restart deployment/target-service -n production",
  targetService = "production-cluster",
  onCompleted,
}: InteractiveTerminalModalProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isFinished, setIsFinished] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setLogs([]);
      setIsRunning(true);
      setIsFinished(false);

      const generatedLogs = [
        `$ ${commandText}`,
        `[INFO] Initializing SRE Remediation Session for ${targetService}...`,
        `[INFO] Authenticating cluster context: context=prod-us-east-1`,
        `[EXEC] Sending execution signal: "${actionTitle}"`,
        `[STEP 1/3] Draining active traffic from unhealthy pods...`,
        `[STEP 2/3] Applying patch and scaling replacement workloads...`,
        `[STEP 3/3] Performing health probe check on http://${targetService}/healthz...`,
        `[SUCCESS] Health probe returned HTTP 200 OK (latency: 14ms)`,
        `[VERIFIED] Remediation completed successfully. Incident risk neutralized.`,
      ];

      let currentStep = 0;
      const interval = setInterval(() => {
        if (currentStep < generatedLogs.length) {
          const nextLog = generatedLogs[currentStep];
          setLogs((prev) => [...prev, nextLog]);
          currentStep++;
        } else {
          clearInterval(interval);
          setIsRunning(false);
          setIsFinished(true);
          if (onCompleted) onCompleted();
        }
      }, 550);

      return () => clearInterval(interval);
    }
  }, [isOpen, actionTitle, commandText, targetService]);

  return (
    <Dialog open={isOpen} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/70 backdrop-blur-md" aria-hidden="true" />

      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="mx-auto max-w-2xl w-full rounded-xl bg-slate-950 border border-slate-800 shadow-2xl overflow-hidden font-mono">
          {/* Terminal Window Bar */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-amber-500/80" />
                <div className="w-3 h-3 rounded-full bg-emerald-500/80" />
              </div>
              <span className="text-xs text-slate-400 ml-2 font-medium flex items-center gap-1.5">
                <IoTerminal className="w-4 h-4 text-emerald-400" />
                sre-remediation-cli (~/{targetService})
              </span>
            </div>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-white transition"
            >
              <IoClose className="w-5 h-5" />
            </button>
          </div>

          {/* Terminal Body */}
          <div className="p-4 h-72 overflow-y-auto bg-slate-950 text-xs leading-relaxed space-y-1.5">
            {logs.map((log, index) => {
              const isCmd = log.startsWith("$");
              const isSuccess = log.includes("[SUCCESS]") || log.includes("[VERIFIED]");
              const isInfo = log.includes("[INFO]");
              const isExec = log.includes("[EXEC]");

              return (
                <div
                  key={index}
                  className={`font-mono ${
                    isCmd
                      ? "text-emerald-400 font-bold"
                      : isSuccess
                      ? "text-emerald-300 font-semibold"
                      : isExec
                      ? "text-amber-400"
                      : isInfo
                      ? "text-sky-400"
                      : "text-slate-300"
                  }`}
                >
                  {log}
                </div>
              );
            })}
            {isRunning && (
              <div className="flex items-center gap-1 text-emerald-400 animate-pulse">
                <span>▋</span>
              </div>
            )}
          </div>

          {/* Footer Bar */}
          <div className="px-4 py-3 bg-slate-900 border-t border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              {isRunning && (
                <Badge color="amber" size="xs">
                  Executing Command...
                </Badge>
              )}
              {isFinished && (
                <Badge color="emerald" size="xs" className="flex items-center gap-1">
                  <IoCheckmarkCircle className="w-3.5 h-3.5" /> Action Verified
                </Badge>
              )}
            </div>
            <Button
              size="xs"
              color={isFinished ? "emerald" : "gray"}
              onClick={onClose}
            >
              {isFinished ? "Close Terminal" : "Cancel"}
            </Button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
