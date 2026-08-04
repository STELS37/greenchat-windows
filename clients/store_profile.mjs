import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const START = "GC_MESSENGER_EXCLUDE_START";
const END = "GC_MESSENGER_EXCLUDE_END";
const DIRECT_START = "GC_MESSENGER_DIRECT_APK_ONLY_START";
const DIRECT_END = "GC_MESSENGER_DIRECT_APK_ONLY_END";
// D-008, inverse direction: code that must exist in every messenger channel EXCEPT the direct APK.
// The chats-only channels hardcode `features.payments = false`; the superapp APK must not carry that
// suppression at all — not even behind a runtime flag — so the artifact verifier can prove by content
// that no code path inside the superapp build can switch the finance contour off.
const DIRECT_EXCLUDE_START = "GC_MESSENGER_DIRECT_APK_EXCLUDE_START";
const DIRECT_EXCLUDE_END = "GC_MESSENGER_DIRECT_APK_EXCLUDE_END";

const MESSENGER_CHANNELS = new Set([
  "messenger-direct-apk",
  "messenger-test-apk",
  "messenger-store-managed",
]);

// B-P0-5 (owner directive 2026-07-31, measured in Google Play Console the same day): creating the
// store listing failed with «этот идентификатор пакета уже используется» for `app.greenchat`, and
// https://play.google.com/store/apps/details?id=app.greenchat answers 404 — the id is reserved by a
// draft in a foreign developer account, and Play has no self-service way to reclaim it. The direct
// APK keeps `app.greenchat` because every already-installed beta updates in place through that id;
// changing it there would install a second app instead of an update. So the application id joins the
// launcher name (B-P0-3) in the edition contract: the superapp and the chats-only store edition are
// two products with two identities. `cc.globalsystem.greenchat` is the reverse of the backend origin
// greenchat.globalsystem.cc and is the id reserved by our own Play listing.
export const SUPERAPP_APPLICATION_ID = "app.greenchat";
export const STORE_MANAGED_APPLICATION_ID = "cc.globalsystem.greenchat";

export function messengerApplicationId(distributionChannel) {
  const value = String(distributionChannel ?? "").trim();
  if (value !== "development" && !MESSENGER_CHANNELS.has(value)) {
    throw new Error(
      `unknown distribution channel ${JSON.stringify(distributionChannel)}`,
    );
  }
  return value === "messenger-store-managed"
    ? STORE_MANAGED_APPLICATION_ID
    : SUPERAPP_APPLICATION_ID;
}

export function parseStoreProfile(raw) {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (value === "" || value === "development") return "development";
  if (value === "messenger") return "messenger";
  throw new Error(
    `GC_STORE_PROFILE must be empty, development or messenger (received ${JSON.stringify(raw)})`,
  );
}

// A public deploy must not ship developer source maps: the messenger profile already disables them,
// but the web site is built with the development profile, so publication needs its own explicit switch.
// Empty means "keep the historical development behaviour"; only "none" strips the maps.
export function parseWebSourceMaps(raw) {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (value === "" || value === "external") return "external";
  if (value === "none") return "none";
  throw new Error(
    `GC_WEB_SOURCEMAPS must be empty, external or none (received ${JSON.stringify(raw)})`,
  );
}

export function parseDistributionChannel(raw, profile) {
  const storeProfile = parseStoreProfile(profile);
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (storeProfile === "development") {
    if (value === "" || value === "development") return "development";
    throw new Error(
      "GC_DISTRIBUTION_CHANNEL must be empty or development for the development profile",
    );
  }
  if (MESSENGER_CHANNELS.has(value)) return value;
  throw new Error(
    "GC_DISTRIBUTION_CHANNEL must be explicitly messenger-direct-apk, messenger-test-apk or messenger-store-managed for the messenger profile",
  );
}

export function filterStoreProfileSource(
  source,
  distributionChannel,
  filename = "source",
) {
  if (!MESSENGER_CHANNELS.has(distributionChannel)) {
    throw new Error(
      `cannot filter messenger source for distribution channel ${JSON.stringify(distributionChannel)}`,
    );
  }
  const lines = String(source).split(/(?<=\n)/);
  const kept = [];
  let block = null;
  const isDirectApk = distributionChannel === "messenger-direct-apk";
  const OPENERS = {
    [START]: { end: END, keep: false, label: "messenger exclusion" },
    [DIRECT_START]: {
      end: DIRECT_END,
      keep: isDirectApk,
      label: "messenger direct APK block",
    },
    [DIRECT_EXCLUDE_START]: {
      end: DIRECT_EXCLUDE_END,
      keep: !isDirectApk,
      label: "messenger direct APK exclusion",
    },
  };
  const CLOSERS = {
    [END]: "messenger exclusion",
    [DIRECT_END]: "messenger direct APK block",
    [DIRECT_EXCLUDE_END]: "messenger direct APK exclusion",
  };
  const ALL_MARKERS = [
    START,
    END,
    DIRECT_START,
    DIRECT_END,
    DIRECT_EXCLUDE_START,
    DIRECT_EXCLUDE_END,
  ];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const markers = ALL_MARKERS.filter((marker) => line.includes(marker));
    if (markers.length > 1) {
      throw new Error(
        `${filename}:${index + 1}: multiple messenger profile markers on one line`,
      );
    }
    const marker = markers[0];
    const opener = OPENERS[marker];
    if (opener) {
      if (block) {
        throw new Error(
          `${filename}:${index + 1}: nested messenger profile block`,
        );
      }
      block = { ...opener, startLine: index + 1 };
      continue;
    }
    if (CLOSERS[marker]) {
      if (!block) {
        const label = CLOSERS[marker];
        throw new Error(`${filename}:${index + 1}: unexpected ${label} end`);
      }
      if (marker !== block.end) {
        throw new Error(
          `${filename}:${index + 1}: mismatched ${block.label} end`,
        );
      }
      block = null;
      continue;
    }
    if (!block || block.keep) kept.push(line);
  }
  if (block) {
    throw new Error(`${filename}:${block.startLine}: unclosed ${block.label}`);
  }
  return kept.join("");
}

export function stripMessengerExcluded(source, filename = "source") {
  return filterStoreProfileSource(source, "messenger-store-managed", filename);
}

function isInside(path, root) {
  const candidate = resolve(path);
  const base = resolve(root);
  return candidate === base || candidate.startsWith(base + sep);
}

export function messengerSourceFilterPlugin({ roots, distributionChannel }) {
  const allowedRoots = roots.map((root) => resolve(root));
  return {
    name: "green-chat-messenger-source-filter",
    setup(build) {
      build.onLoad({ filter: /\.(?:css|ts)$/ }, async (args) => {
        if (!allowedRoots.some((root) => isInside(args.path, root)))
          return null;
        const extension = extname(args.path);
        const source = await readFile(args.path, "utf8");
        return {
          contents: filterStoreProfileSource(
            source,
            distributionChannel,
            args.path,
          ),
          loader: extension === ".css" ? "css" : "ts",
        };
      });
    },
  };
}
