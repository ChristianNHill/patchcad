import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

/**
 * Runs INSIDE the preview iframe. Provides:
 *  - ParamsProvider: receives T0 param pushes from the studio via postMessage
 *    and re-renders consumers with zero rebuild.
 *  - usePatchcadParam: how generated node code reads a live param.
 *  - NodeErrorBoundary: one broken node must not blank the whole preview.
 */

type ParamMap = Record<string, Record<string, unknown>>;

const ParamsContext = createContext<ParamMap>({});

interface ParamsMessage {
  type: "patchcad:params";
  nodeId: string;
  params: Record<string, unknown>;
}

interface ParamsInitMessage {
  type: "patchcad:params:init";
  all: ParamMap;
}

export function ParamsProvider({
  initial,
  children,
}: {
  initial?: ParamMap;
  children: ReactNode;
}) {
  const [params, setParams] = useState<ParamMap>(initial ?? {});

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as ParamsMessage | ParamsInitMessage | undefined;
      if (!data || typeof data !== "object") return;
      if (data.type === "patchcad:params") {
        setParams((prev) => ({
          ...prev,
          [data.nodeId]: { ...prev[data.nodeId], ...data.params },
        }));
      } else if (data.type === "patchcad:params:init") {
        setParams(data.all);
      }
    }
    window.addEventListener("message", onMessage);
    // Tell the host we're ready to receive the initial param snapshot.
    window.parent?.postMessage({ type: "patchcad:preview:ready" }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return <ParamsContext.Provider value={params}>{children}</ParamsContext.Provider>;
}

export function usePatchcadParam<T>(nodeId: string, key: string, fallback: T): T {
  const all = useContext(ParamsContext);
  const value = all[nodeId]?.[key];
  return (value === undefined ? fallback : value) as T;
}

interface BoundaryProps {
  nodeId: string;
  children: ReactNode;
}

interface BoundaryState {
  error: Error | null;
}

export class NodeErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error) {
    window.parent?.postMessage(
      { type: "patchcad:node:error", nodeId: this.props.nodeId, message: error.message },
      "*",
    );
  }

  override render() {
    if (this.state.error) {
      // Standalone chrome: this renders inside generated apps, which own their
      // own styling — tinted one-off values, deliberately quiet.
      return (
        <div
          style={{
            border: "1px solid oklch(66% 0.17 25)",
            borderRadius: 8,
            padding: 12,
            fontFamily: "ui-monospace, monospace",
            fontSize: 12,
            color: "oklch(45% 0.16 25)",
            background: "oklch(97% 0.012 25)",
          }}
        >
          <strong>node “{this.props.nodeId}” crashed:</strong> {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}
