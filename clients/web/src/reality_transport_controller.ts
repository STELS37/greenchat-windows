// T-605 / NR-05 — signed /v1/config → optional Android app-scoped REALITY lifecycle.
//
// The native bridge is a capability, never a source of routing policy. This controller accepts endpoint
// arrays only after NR-03 signature verification. Operations are serialized so the process-global WebView
// proxy never has two competing engines. Replacement is transactional: when a new engine fails to start,
// the exact previous verified plan is restored before the caller rejects the client config commit.
import {
  isStructuredEndpoint,
  orderEndpointInputs,
  parseEndpointInput,
  type EndpointInput,
  type StructuredEndpoint,
} from "../../core/src/endpoints.ts";
import {
  buildRealityEnginePlan,
  type RealityEnginePlan,
} from "../../mobile/bridge/reality_config.ts";
import type { RealityTransportBridge } from "../../mobile/bridge/reality_transport.ts";

export type RealityTransportApplyStatus =
  | "active"
  | "unchanged"
  | "direct_only"
  | "unsupported"
  | "invalid_config"
  | "failed";

export interface RealityTransportApplyResult {
  status: RealityTransportApplyStatus;
}

export interface RealityTransportController {
  // Must receive only the endpoint field of an already signature-verified /v1/config response.
  applySignedEndpoints(rawEndpoints: unknown): Promise<RealityTransportApplyResult>;
  // Clears the native WebView proxy before a user-selected server origin changes.
  stop(): Promise<RealityTransportApplyResult>;
}

type ResolvedPlan =
  | { status: "plan"; plan: RealityEnginePlan; identity: string }
  | { status: "direct_only" | "invalid_config"; plan: null; identity: null };

interface ActivePlan {
  identity: string;
  plan: RealityEnginePlan;
}

function structuredEndpoints(rawEndpoints: unknown): StructuredEndpoint[] {
  if (!Array.isArray(rawEndpoints)) return [];
  const parsed: EndpointInput[] = [];
  for (const raw of rawEndpoints) {
    const endpoint = parseEndpointInput(raw);
    if (endpoint !== null) parsed.push(endpoint);
  }
  return orderEndpointInputs(parsed).filter(isStructuredEndpoint);
}

function resolvePlan(rawEndpoints: unknown): ResolvedPlan {
  const endpoints = structuredEndpoints(rawEndpoints);
  const realityEndpoints = endpoints.filter((endpoint) => endpoint.transport === "reality");
  if (realityEndpoints.length === 0) return { status: "direct_only", plan: null, identity: null };

  // The native route has a block final. Every ordinary GreenChat origin therefore must be explicitly
  // direct; starting from a REALITY-only list would cut off the current backend before failover is needed.
  const directEndpoints = endpoints.filter((endpoint) => endpoint.transport === "direct");
  if (directEndpoints.length === 0) return { status: "invalid_config", plan: null, identity: null };

  try {
    const plan = buildRealityEnginePlan({ directEndpoints, realityEndpoints });
    return { status: "plan", plan, identity: `${plan.proxyUrl}\n${plan.configJson}` };
  } catch {
    return { status: "invalid_config", plan: null, identity: null };
  }
}

export function createRealityTransportController(options: {
  bridge: RealityTransportBridge | null;
}): RealityTransportController {
  const bridge = options.bridge;
  let active: ActivePlan | null = null;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = chain.then(operation, operation);
    chain = result.then(() => undefined, () => undefined);
    return result;
  };

  const stopActive = async (): Promise<boolean> => {
    if (active === null || bridge === null) {
      active = null;
      return true;
    }
    try {
      await bridge.stop();
      active = null;
      return true;
    } catch {
      // Preserve the plan: the global proxy may still be active. Later work retries the same stop and
      // never stacks another engine on top of uncertain native state.
      return false;
    }
  };

  const startPlan = async (next: ActivePlan): Promise<boolean> => {
    if (bridge === null) return false;
    try {
      await bridge.start(next.plan);
      active = next;
      return true;
    } catch {
      active = null;
      return false;
    }
  };

  const applySignedEndpoints = (rawEndpoints: unknown): Promise<RealityTransportApplyResult> => {
    const resolved = resolvePlan(rawEndpoints);
    return enqueue(async () => {
      if (resolved.status === "invalid_config") {
        // Candidate was never committed by ConnectionManager; keep the last verified engine untouched.
        return { status: "invalid_config" };
      }
      if (resolved.status === "direct_only") {
        if (bridge !== null && active !== null && !(await stopActive())) return { status: "failed" };
        return { status: "direct_only" };
      }
      if (resolved.status !== "plan") return { status: "invalid_config" }; // exhaustive defensive guard
      if (bridge === null) return { status: "unsupported" };
      if (active?.identity === resolved.identity) return { status: "unchanged" };

      const previous = active;
      if (previous !== null && !(await stopActive())) return { status: "failed" };

      const next: ActivePlan = { identity: resolved.identity, plan: resolved.plan };
      if (await startPlan(next)) return { status: "active" };

      // Replacement failed after the old engine was cleared. Restore the exact previous verified plan;
      // regardless of rollback success the candidate config is refused by the caller.
      if (previous !== null) await startPlan(previous);
      return { status: "failed" };
    });
  };

  const stop = (): Promise<RealityTransportApplyResult> => enqueue(async () => {
    if (bridge === null || active === null) {
      active = null;
      return { status: "direct_only" };
    }
    return { status: await stopActive() ? "direct_only" : "failed" };
  });

  return { applySignedEndpoints, stop };
}
