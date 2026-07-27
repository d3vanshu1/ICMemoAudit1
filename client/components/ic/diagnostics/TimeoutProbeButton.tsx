/**
 * TEMPORARY DIAGNOSTIC — Client-path timeout probe trigger.
 *
 * Fires DiagTimeoutProbe via executeApi (the client-invoked path, same as
 * RunModulePipeline) — NOT the editor Test button which has a relaxed limit.
 *
 * After fire: polls ListTimeoutProbes to show DB row status, since the
 * client promise is severed at the platform cap and won't return survivedMs.
 *
 * Usage: run 305s first (control), then 590s. Remove after cap is confirmed.
 */
import { useState, useCallback, useRef } from "react";
import { executeApi } from "@/lib/executeApi.js";

interface ProbeResult {
  probe_id: string;
  started_at: string;
  last_heartbeat_at: string;
  completed_at: string | null;
  elapsed_ms: number | null;
}

type ProbeState = "idle" | "firing" | "polling" | "done" | "error";

export default function TimeoutProbeButton() {
  const [sleepSeconds, setSleepSeconds] = useState(305);
  const [state, setState] = useState<ProbeState>("idle");
  const [probeId, setProbeId] = useState<string | null>(null);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Poll the DB table for the most recent probe row
  const startPolling = useCallback(() => {
    setState("polling");
    let count = 0;
    let foundId: string | null = null;

    const poll = async () => {
      count++;
      setPollCount(count);
      try {
        const res = await executeApi("ListTimeoutProbes", { limit: 5 });
        const rows = (res as { rows: ProbeResult[] })?.rows;
        if (rows && rows.length > 0) {
          const latest = rows[0]; // Sorted by started_at desc
          if (!foundId) {
            foundId = latest.probe_id;
            setProbeId(latest.probe_id);
          }
          const tracked = rows.find((p) => p.probe_id === foundId) ?? latest;
          setResult(tracked);

          if (tracked.completed_at) {
            stopPolling();
            setState("done");
          }
        }
      } catch {
        // Keep polling — transient failure
      }
    };

    poll();
    pollRef.current = setInterval(poll, 20_000);

    // Auto-stop after 15 min
    setTimeout(() => {
      stopPolling();
      setState((s) => (s === "polling" ? "done" : s));
    }, 15 * 60 * 1000);
  }, [stopPolling]);

  // Fire the probe via the client execution path
  const fireProbe = useCallback(async () => {
    setState("firing");
    setError(null);
    setResult(null);
    setProbeId(null);
    setPollCount(0);
    stopPolling();

    try {
      // Fire via client path (executeApi → executeSdkApiV3).
      // This promise will be severed at the platform cap — that's expected.
      const firePromise = executeApi("DiagTimeoutProbe", { sleepSeconds });

      // Let the fire promise resolve or reject in background
      firePromise
        .then((res: unknown) => {
          const typed = res as { probeId?: string };
          if (typed?.probeId) setProbeId(typed.probeId);
        })
        .catch(() => {
          // Expected: severed at cap — probe row still in DB
        });

      // Wait 5s for the INSERT to land, then start polling
      await new Promise((r) => setTimeout(r, 5000));
      startPolling();
    } catch (e) {
      setError(`Failed to fire probe: ${e}`);
      setState("error");
    }
  }, [sleepSeconds, stopPolling, startPolling]);

  const formatTimeDiff = (start: string, end: string) => {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    return `${(ms / 1000).toFixed(1)}s`;
  };

  return (
    <div className="mt-8 p-4 border border-dashed border-yellow-500 rounded-lg bg-yellow-50/50">
      <h3 className="font-bold text-sm text-yellow-800 mb-2">
        ⚡ Timeout Probe (client-path via executeApi) — TEMPORARY DIAGNOSTIC
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        Invokes DiagTimeoutProbe through the client execution path (executeSdkApiV3), same path as RunModulePipeline.
        NOT the editor Test button. Reads result from DB since client promise is severed at cap.
      </p>

      <div className="flex items-center gap-3 mb-3">
        <label className="text-xs text-gray-600">Sleep seconds:</label>
        <input
          type="number"
          value={sleepSeconds}
          onChange={(e) => setSleepSeconds(Number(e.target.value))}
          className="w-20 px-2 py-1 border rounded text-sm"
          disabled={state === "firing" || state === "polling"}
        />
        <button
          onClick={fireProbe}
          disabled={state === "firing" || state === "polling"}
          className="px-3 py-1 bg-yellow-600 text-white text-sm rounded hover:bg-yellow-700 disabled:opacity-50"
        >
          {state === "idle" || state === "done" || state === "error"
            ? "Fire Probe"
            : state === "firing"
            ? "Firing…"
            : `Polling (${pollCount})…`}
        </button>
        {state === "polling" && (
          <button
            onClick={() => { stopPolling(); setState("done"); }}
            className="px-2 py-1 text-xs border rounded text-gray-600 hover:bg-gray-100"
          >
            Stop Polling
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

      {probeId && (
        <p className="text-xs text-gray-500 mb-1 font-mono">probe_id: {probeId}</p>
      )}

      {result && (
        <div className="text-xs font-mono bg-white p-2 rounded border">
          <p><strong>started_at:</strong> {result.started_at}</p>
          <p><strong>last_heartbeat_at:</strong> {result.last_heartbeat_at}</p>
          <p>
            <strong>heartbeat − started:</strong>{" "}
            {formatTimeDiff(result.started_at, result.last_heartbeat_at)}
          </p>
          <p>
            <strong>completed_at:</strong>{" "}
            {result.completed_at ? (
              <span className="text-green-700">{result.completed_at}</span>
            ) : (
              <span className="text-red-600">null (killed or still running)</span>
            )}
          </p>
          {result.elapsed_ms != null && (
            <p><strong>elapsed_ms:</strong> {result.elapsed_ms}</p>
          )}
          <p className="mt-1 font-sans">
            <strong>Interpretation:</strong>{" "}
            {result.completed_at
              ? `✅ SURVIVED — completed in ${(result.elapsed_ms! / 1000).toFixed(1)}s. Client cap > ${sleepSeconds}s.`
              : `⏳ Heartbeat at ${formatTimeDiff(result.started_at, result.last_heartbeat_at)} — still running or killed at cap.`
            }
          </p>
        </div>
      )}
    </div>
  );
}
