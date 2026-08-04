export type StoreProfile = "development" | "messenger";
export type DistributionChannel =
  | "development"
  | "messenger-direct-apk"
  | "messenger-test-apk"
  | "messenger-store-managed";

// B-P0-5: the two editions ship under different application ids, so the id is derived from the
// channel and never hardcoded at a call site. Declared here because the mobile bridge tests import
// all three by name — an undeclared export makes the whole clients typecheck fail, which silently
// disables `clients/mobile/check.sh` before it runs a single test.
export declare const SUPERAPP_APPLICATION_ID: "app.greenchat";
export declare const STORE_MANAGED_APPLICATION_ID: "cc.globalsystem.greenchat";
/** Validates at runtime like `parseDistributionChannel`: an unknown channel throws, never guesses. */
export declare function messengerApplicationId(
  distributionChannel: unknown,
): typeof SUPERAPP_APPLICATION_ID | typeof STORE_MANAGED_APPLICATION_ID;

export declare function parseStoreProfile(raw: unknown): StoreProfile;
export declare function parseDistributionChannel(
  raw: unknown,
  profile: StoreProfile,
): DistributionChannel;
export declare function filterStoreProfileSource(
  source: string,
  distributionChannel: Exclude<DistributionChannel, "development">,
  filename?: string,
): string;
export declare function stripMessengerExcluded(
  source: string,
  filename?: string,
): string;
export declare function messengerSourceFilterPlugin(options: {
  roots: string[];
  distributionChannel: Exclude<DistributionChannel, "development">;
}): import("esbuild").Plugin;
