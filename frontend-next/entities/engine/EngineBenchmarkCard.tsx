"use client";

import clsx from "clsx";
import { useEngineBenchmark } from "./useEngine";

const pct = (x: number) => `${Math.round(x * 100)}%`;

function tone(v: number) {
  return v >= 0.8 ? "text-green-700" : v >= 0.6 ? "text-amber-700" : "text-red-700";
}

function Bar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
      <div
        className={clsx(
          "h-full rounded-full",
          value >= 0.8 ? "bg-green-500" : value >= 0.6 ? "bg-amber-500" : "bg-red-500"
        )}
        style={{ width: `${Math.max(2, value * 100)}%` }}
      />
    </div>
  );
}

/**
 * The engine's accuracy on held-out generated estates (GET /engine/benchmark).
 * This is the engine's real generalisation number; the golden run above is a
 * reproduction check, and the baseline pipeline below is a different algorithm.
 */
export function EngineBenchmarkCard() {
  const { data, error, isLoading } = useEngineBenchmark();

  return (
    <section
      className="kpi-card rounded-2xl border border-green-200 p-4"
      style={{
        background: "linear-gradient(160deg,#fff 60%,#f0fdf4)",
        boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -12px rgba(16,24,40,.12)",
      }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <h2 className="text-sm font-bold text-gray-900">
            Engine benchmark: held-out estates
          </h2>
          <p className="text-xs text-gray-600 max-w-3xl">
            The real engine, run on generated estates that vary topology, telemetry, incident count
            and timing, scored against an answer key it never reads.
            {data && <> Seeds {data.seeds[0]}–{data.seeds[data.seeds.length - 1]} are held out: the engine&apos;s thresholds were tuned on other seeds.</>}
          </p>
        </div>
        {data && (
          <div className="flex gap-2">
            <div className="rounded-xl border border-green-200 bg-white px-3 py-2 text-center">
              <div className={clsx("text-xl font-extrabold tabular-nums", tone(data.overall.root_cause_accuracy))}>
                {pct(data.overall.root_cause_accuracy)}
              </div>
              <div className="text-[11px] text-gray-600">root cause correct</div>
            </div>
            <div className="rounded-xl border border-green-200 bg-white px-3 py-2 text-center">
              <div className={clsx("text-xl font-extrabold tabular-nums", tone(data.overall.pair_f1))}>
                {data.overall.pair_f1.toFixed(2)}
              </div>
              <div className="text-[11px] text-gray-600">grouping F1 ({data.overall.runs} runs)</div>
            </div>
          </div>
        )}
      </div>

      {isLoading && <p className="text-sm text-gray-600">Running the benchmark (a few seconds, once)...</p>}
      {error && <p className="text-sm text-red-700">Benchmark unavailable: {String(error)}</p>}

      {data && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-600">
                  <th className="py-1.5 pr-3 font-semibold">Scenario</th>
                  <th className="py-1.5 pr-3 font-semibold w-40">Grouping F1</th>
                  <th className="py-1.5 pr-3 font-semibold">Precision</th>
                  <th className="py-1.5 pr-3 font-semibold">Recall</th>
                  <th className="py-1.5 pr-3 font-semibold">Root cause</th>
                  <th className="py-1.5 pr-3 font-semibold">Median time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.configs.map((r) => (
                  <tr key={r.key}>
                    <td className="py-2 pr-3">
                      <span className="font-semibold text-gray-900">{r.label}</span>
                      <span className="ml-1.5 text-gray-500">~{r.avg_signals} signals</span>
                      {r.concurrent && (
                        <span className="ml-1.5 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                          hard case
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <span className={clsx("w-9 font-bold tabular-nums", tone(r.pair_f1))}>{r.pair_f1.toFixed(2)}</span>
                        <Bar value={r.pair_f1} />
                      </div>
                    </td>
                    <td className={clsx("py-2 pr-3 tabular-nums", tone(r.pair_precision))}>{r.pair_precision.toFixed(2)}</td>
                    <td className={clsx("py-2 pr-3 tabular-nums", tone(r.pair_recall))}>{r.pair_recall.toFixed(2)}</td>
                    <td className={clsx("py-2 pr-3 tabular-nums", tone(r.root_cause_accuracy))}>
                      {r.root_cause_correct}/{r.root_cause_total}
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-gray-700">{r.median_runtime_ms} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <b>Known limitation.</b> When two failures hit the same service, or two directly
            connected services, in the same minute, they pass the shared-context gate together and
            can be drafted as one incident: precision drops while recall stays high. Root cause stays
            accurate, and a reviewer can split them with <i>Merge</i>/<i>Reject</i>. A threshold sweep
            (tuned on seeds 1–20) found no setting that fixes it, so the fix is structural: weigh
            error-type evidence more heavily when incidents are concurrent.
          </div>
        </>
      )}
    </section>
  );
}
