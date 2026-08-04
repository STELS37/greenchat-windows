import type { RealityEnginePlan } from "./reality_config.ts";

export type RealityUnavailableReason =
  | "engine_not_packaged"
  | "static_proxy_conflict"
  | "webview_proxy_unsupported"
  | "abi_unsupported"
  | "engine_class_unavailable"
  | "native_plugin_unavailable";

export interface RealityTransportStatus {
  available: boolean;
  packaged: boolean;
  active: boolean;
  reason: RealityUnavailableReason | null;
}

export interface RawRealityTransportPlugin {
  availability(): Promise<Partial<RealityTransportStatus>>;
  status(): Promise<Partial<RealityTransportStatus>>;
  start(options: { configJson: string; proxyUrl: string }): Promise<{ active?: boolean }>;
  stop(): Promise<{ active?: boolean }>;
}

export interface RealityTransportBridge {
  availability(): Promise<RealityTransportStatus>;
  status(): Promise<RealityTransportStatus>;
  start(plan: RealityEnginePlan): Promise<void>;
  stop(): Promise<void>;
}

const UNAVAILABLE: RealityTransportStatus = {
  available: false,
  packaged: false,
  active: false,
  reason: "native_plugin_unavailable",
};

function normalize(raw: Partial<RealityTransportStatus>): RealityTransportStatus {
  const available = raw.available === true;
  const reason = available ? null : (
    typeof raw.reason === "string" ? raw.reason as RealityUnavailableReason : "native_plugin_unavailable"
  );
  return {
    available,
    packaged: raw.packaged === true,
    active: raw.active === true,
    reason,
  };
}

export function wrapRealityTransport(raw: RawRealityTransportPlugin): RealityTransportBridge {
  return {
    async availability() {
      try { return normalize(await raw.availability()); } catch { return { ...UNAVAILABLE }; }
    },
    async status() {
      try { return normalize(await raw.status()); } catch { return { ...UNAVAILABLE }; }
    },
    async start(plan) {
      if (!plan.proxyUrl.startsWith("socks://127.0.0.1:") || plan.configJson.length === 0 || plan.configJson.length > 64 * 1024) {
        throw new Error("RealityTransport.start: invalid generated plan");
      }
      const availability = await this.availability();
      if (!availability.available) throw new Error(`RealityTransport unavailable: ${availability.reason}`);
      const result = await raw.start({ configJson: plan.configJson, proxyUrl: plan.proxyUrl });
      if (result.active !== true) throw new Error("RealityTransport.start: native engine did not become active");
    },
    async stop() {
      const result = await raw.stop();
      if (result.active === true) throw new Error("RealityTransport.stop: native engine remained active");
    },
  };
}
