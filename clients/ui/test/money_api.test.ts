// T005 — the money transport: every path, query and body pinned.
//
// Route names and field names are the part of a payment client that cannot be "mostly right": a typo
// sends a withdrawal to a 404 or, worse, drops the PIN field and the server refuses in a way the user
// reads as "wrong amount". So the fake transport records what would have gone out and the test
// asserts it character for character against server/src/modules/{wallet,onchain,exchange,swaps}.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMoneyApi, pairSegment } from "../src/screens/money_api.ts";
import type { ApiLike } from "../src/screens/api.ts";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function recorder(): { api: ApiLike; calls: Call[] } {
  const calls: Call[] = [];
  const answer = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    calls.push(body === undefined ? { method, path } : { method, path, body });
    return {} as T;
  };
  const api: ApiLike = {
    get: (path) => answer("GET", path),
    post: (path, body) => answer("POST", path, body),
    put: (path, body) => answer("PUT", path, body),
    patch: (path, body) => answer("PATCH", path, body),
    delete: (path, opts) => answer("DELETE", path, opts?.body),
    refreshTokens: async () => true,
  };
  return { api, calls };
}

test("pair identifiers travel as ONE encoded segment", async () => {
  // server/src/core/http.ts matches the raw pathname segment-by-segment and decodes each capture, so
  // a bare slash would make "/v1/ex/ticker/BTC/GUSD" a five-segment path that matches no route.
  assert.equal(pairSegment("BTC/GUSD"), "BTC%2FGUSD");
  const { api, calls } = recorder();
  const money = createMoneyApi(api);
  await money.ticker("BTC/GUSD");
  await money.depth("BTC/GUSD");
  await money.trades("BTC/GUSD");
  await money.candles("BTC/GUSD", "5m", 100, 700);
  assert.deepEqual(calls.map((call) => call.path), [
    "/v1/ex/ticker/BTC%2FGUSD",
    "/v1/ex/depth/BTC%2FGUSD",
    "/v1/ex/trades/BTC%2FGUSD",
    "/v1/ex/candles/BTC%2FGUSD?tf=5m&from=100&to=700",
  ]);
  assert.ok(calls.every((call) => call.method === "GET"));
});

test("wallet reads: exact paths, and omitted query parameters stay omitted", async () => {
  const { api, calls } = recorder();
  const money = createMoneyApi(api);
  await money.wallet();
  await money.walletHistory();
  await money.walletHistory(8);
  await money.walletHistory(8, 41);
  await money.depositAddress("tbtc");
  await money.deposits();
  await money.withdrawals();
  await money.whitelist();
  assert.deepEqual(calls.map((call) => call.path), [
    "/v1/wallet",
    "/v1/wallet/history",
    "/v1/wallet/history?limit=8",
    "/v1/wallet/history?limit=8&before_id=41",
    "/v1/wallet/deposit_address?chain=tbtc",
    "/v1/wallet/deposits",
    "/v1/wallet/withdrawals",
    "/v1/wallet/whitelist",
  ]);
});

test("a withdrawal body carries the fields parseWithdrawal reads, amount as nano", async () => {
  const { api, calls } = recorder();
  const money = createMoneyApi(api);
  await money.createWithdrawal({
    chain: "tbtc",
    asset: "TBTC",
    to_address: "tb1qexample",
    amount: "2500000000",
    client_op_id: "op-1",
    pin: "1234",
    code: "000000",
  });
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, "/v1/wallet/withdrawals");
  assert.deepEqual(calls[0]!.body, {
    chain: "tbtc",
    asset: "TBTC",
    to_address: "tb1qexample",
    amount: "2500000000",
    client_op_id: "op-1",
    pin: "1234",
    code: "000000",
  });
});

test("cancel/delete build id paths and refuse a non-id instead of calling a wrong route", async () => {
  const { api, calls } = recorder();
  const money = createMoneyApi(api);
  await money.cancelWithdrawal(7);
  await money.deleteWhitelist(3);
  await money.cancelOrder(11);
  assert.deepEqual(calls, [
    { method: "POST", path: "/v1/wallet/withdrawals/7/cancel" },
    { method: "DELETE", path: "/v1/wallet/whitelist/3" },
    { method: "DELETE", path: "/v1/ex/orders/11" },
  ]);
  await assert.rejects(() => money.cancelWithdrawal(0), RangeError);
  await assert.rejects(() => money.deleteWhitelist(-1), RangeError);
  await assert.rejects(() => money.cancelOrder(1.5), RangeError);
  assert.equal(calls.length, 3, "a rejected id must not reach the transport");
});

test("orders: status filter is optional, and an order body keeps nano strings verbatim", async () => {
  const { api, calls } = recorder();
  const money = createMoneyApi(api);
  await money.orders();
  await money.orders("open");
  await money.placeOrder({
    pair: "BTC/GUSD",
    side: "buy",
    type: "limit",
    qty: "1000000000",
    price: "30000000000000",
    client_order_id: "cid-1",
    tif: "GTC",
    post_only: true,
  });
  assert.deepEqual(calls.map((call) => call.path), ["/v1/ex/orders", "/v1/ex/orders?status=open", "/v1/ex/orders"]);
  assert.deepEqual(calls[2]!.body, {
    pair: "BTC/GUSD",
    side: "buy",
    type: "limit",
    qty: "1000000000",
    price: "30000000000000",
    client_order_id: "cid-1",
    tif: "GTC",
    post_only: true,
  });
});

test("swap: quote and execution hit the two POST routes with their own bodies", async () => {
  const { api, calls } = recorder();
  const money = createMoneyApi(api);
  await money.swapQuote({ from: "TBTC", to: "TUSDT", amount: "500000000" });
  await money.swap({ quote_id: 7, pin: "1234" });
  assert.deepEqual(calls, [
    { method: "POST", path: "/v1/ex/swap/quote", body: { from: "TBTC", to: "TUSDT", amount: "500000000" } },
    { method: "POST", path: "/v1/ex/swap", body: { quote_id: 7, pin: "1234" } },
  ]);
});

test("the PIN route re-auths by password and never travels in a query string", async () => {
  const { api, calls } = recorder();
  const money = createMoneyApi(api);
  await money.setWalletPin({ password: "correct horse", pin: "4321", code: "123456" });
  assert.equal(calls[0]!.path, "/v1/wallet/pin");
  assert.equal(calls[0]!.method, "POST");
  assert.deepEqual(calls[0]!.body, { password: "correct horse", pin: "4321", code: "123456" });
  assert.ok(!calls[0]!.path.includes("?"), "credentials must not be in the URL");
});
