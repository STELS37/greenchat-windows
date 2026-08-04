// P0-4 (owner directive 2026-07-30), client half — the money that had already left one wallet and
// could not reach the other.
//
// Measured on the live deployment 2026-07-31 with two fresh accounts: a transfer to somebody the
// sender has never talked to is NOT a direct credit. The server parks it in an envelope (`mode:
// "claimable"`), debits the sender at once and announces it to the recipient over the websocket
// only. The wallet screen had no notion of an envelope at all: the recipient saw no money and no
// button, the sender was told "Transfer sent", and the amount was simply gone from both screens
// until it expired. This test pins the durable surface that fixes it:
//
//   1. an incoming envelope is listed with a claim action, and the action calls the claim route;
//   2. the sender's own parked envelope offers "take back", not "claim";
//   3. a server without GET /v1/envelopes (older deployment) still renders the wallet.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createFinanceScreen } from "../src/screens/finance_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

const WALLET = {
  total_usd: "12500000000",
  approx_fiat: { currency: "EUR", amount: "11.40", stale: false },
  assets: [
    {
      id: "tUSDT",
      name: "Test USDT",
      kind: "demo",
      enabled: true,
      balance: "12500000000",
      hold: "0",
      available: "12500000000",
      usd_value: "12500000000",
      usd_rate: "1000000000",
    },
  ],
  payment_settings: {
    has_pin: false,
    two_factor_enabled: false,
    security_hold_until: 0,
    flags: [],
    pin_required_usd: "20",
  },
};

const HISTORY = { items: [], next_before_id: null };

function envelope(id: number, role: "sender" | "recipient"): Record<string, unknown> {
  return {
    id,
    sender_id: role === "sender" ? 1 : 2,
    chat_id: null,
    target_user_id: role === "sender" ? 2 : 1,
    asset: "tUSDT",
    total: "1000000000",
    remaining: "1000000000",
    parts: 1,
    claimed_parts: 0,
    status: "active",
    expires_at: 1_900_000_000,
    created_at: 1_800_000_000,
    role,
  };
}

class WalletApi implements ApiLike {
  readonly posts: string[] = [];
  // A plain field, not a parameter property: the runner strips types only, it does not compile them.
  private readonly inbox: Record<string, unknown>[] | "unsupported";
  constructor(inbox: Record<string, unknown>[] | "unsupported") {
    this.inbox = inbox;
  }
  get<T>(path: string): Promise<T> {
    if (path === "/v1/config")
      return Promise.resolve({ features: { payments: true, cards: false } } as unknown as T);
    if (path === "/v1/wallet") return Promise.resolve(WALLET as unknown as T);
    if (path === "/v1/wallet/history?limit=8") return Promise.resolve(HISTORY as unknown as T);
    if (path === "/v1/envelopes") {
      if (this.inbox === "unsupported") return Promise.reject(new Error("route not found"));
      return Promise.resolve({ envelopes: this.inbox } as unknown as T);
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(path: string): Promise<T> {
    this.posts.push(path);
    return Promise.resolve({ ok: true } as unknown as T);
  }
  put<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected PUT"));
  }
  patch<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected PATCH"));
  }
  delete<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected DELETE"));
  }
  refreshTokens(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

async function renderWallet(api: WalletApi): Promise<StubNode> {
  const screen = createFinanceScreen({
    api,
    i18n,
    view: "wallet",
    onNavigate() {},
    onBack() {},
  });
  await settle();
  return screen.root as unknown as StubNode;
}

// The stub's selector engine deliberately refuses combinators, so the pending block is located by
// class and walked directly — that also proves the buttons really live inside that block.
function buttons(root: StubNode): StubNode[] {
  const pending = root.find((node) => node.hasClass("gc-finance-pending"));
  if (!pending) return [];
  return pending.findAll((node) => node.tag === "button");
}

test("an incoming claimable transfer is listed with a working claim action", async () => {
  const api = new WalletApi([envelope(11, "recipient")]);
  const root = await renderWallet(api);
  const rendered = root.textContent;
  assert.ok(
    rendered.includes(en["finance.pending"]),
    `the pending section is missing: ${rendered}`,
  );
  assert.ok(
    rendered.includes(en["finance.pendingIncoming"]),
    `the incoming envelope is not named: ${rendered}`,
  );
  // The amount must be human, not the nano wire string.
  assert.ok(rendered.includes("1 tUSDT") || rendered.includes("1.0 tUSDT") || rendered.includes("1 tUSDT"),
    `the pending amount is not readable: ${rendered}`);

  const [claim] = buttons(root);
  assert.ok(claim, "no claim button rendered for an incoming envelope");
  assert.equal(claim.textContent.trim(), en["finance.claim"]);
  claim.dispatch("click");
  await settle();
  assert.ok(
    api.posts.includes("/v1/envelopes/11/claim"),
    `claim did not call the claim route: ${JSON.stringify(api.posts)}`,
  );
});

test("the sender's own parked transfer offers taking it back, not claiming", async () => {
  const api = new WalletApi([envelope(12, "sender")]);
  const root = await renderWallet(api);
  assert.ok(
    root.textContent.includes(en["finance.pendingOutgoing"]),
    `the outgoing envelope is not named: ${root.textContent}`,
  );
  const [action] = buttons(root);
  assert.ok(action, "no action rendered for the sender's own envelope");
  assert.equal(action.textContent.trim(), en["finance.takeBack"]);
  action.dispatch("click");
  await settle();
  assert.ok(
    api.posts.includes("/v1/envelopes/12/refund"),
    `take-back did not call the refund route: ${JSON.stringify(api.posts)}`,
  );
});

test("a server without the envelope inbox still renders the wallet", async () => {
  const api = new WalletApi("unsupported");
  const root = await renderWallet(api);
  assert.ok(root.textContent.includes("12.5"), `the wallet failed to render: ${root.textContent}`);
  assert.ok(
    !root.textContent.includes(en["finance.pending"]),
    "an empty inbox must draw no section at all",
  );
});
