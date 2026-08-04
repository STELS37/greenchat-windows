// clients/core/test/pow_gate.test.ts — T-121 wiring: the POW_REQUIRED retry gate (pow_gate.ts).
//
// Unit half (scripted exec/fetchChallenge — no network): every branch of the bounded retry
// discipline from proposal client-pow-open-registration.md:
//   • acceptance №6: PoW off ⇒ exactly ONE request, ZERO challenge fetches;
//   • acceptance №1/№4: POW_REQUIRED ⇒ exactly ONE challenge fetch and ONE retry carrying the wire pair;
//   • acceptance №5: POW_INVALID on the retry ⇒ exactly ONE fresh challenge, then the error surfaces
//     (no infinite loop); same for a challenge that expires mid-solve;
//   • acceptance №3: abort mid-solve ⇒ PowAbortedError and NO further request.
//
// Integration half (bottom of file): a REAL scratch server booted with GC_POW=1 GC_POW_BITS=8 —
// register end-to-end through the gate (acceptance №7 in CI scope), plus the flag-on reuse verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeWithPow, type PowWire, type PowRunner } from "../src/pow_gate.ts";
import { PowAbortedError, PowExpiredError, type PowChallenge, type PowSolution } from "../src/pow_solver.ts";
import { ApiError } from "../src/errors.ts";
import { startLiveServer, type LiveServer } from "./server-harness.ts";

// ---------------------------------------------------------------- unit half

const powRequired = () => new ApiError("POW_REQUIRED", "proof of work required", 400);
const powInvalid = () => new ApiError("POW_INVALID", "invalid proof of work", 400);

function freshChallenge(salt = "0123456789abcdef"): PowChallenge {
  return { salt, bits: 1, expires_at: Math.floor(Date.now() / 1000) + 300 };
}

// A scripted harness: exec pops queued outcomes; challenge fetches are counted and salted uniquely.
function harness(outcomes: Array<(pow?: PowWire) => unknown>) {
  const execCalls: Array<PowWire | undefined> = [];
  const challenges: PowChallenge[] = [];
  return {
    execCalls,
    challenges,
    exec(pow?: PowWire): Promise<unknown> {
      execCalls.push(pow);
      const fn = outcomes.shift();
      if (!fn) return Promise.reject(new Error("unexpected exec call"));
      try { return Promise.resolve(fn(pow)); } catch (e) { return Promise.reject(e); }
    },
    fetchChallenge(): Promise<PowChallenge> {
      const c = freshChallenge((challenges.length + 1).toString(16).padStart(16, "0"));
      challenges.push(c);
      return Promise.resolve(c);
    },
  };
}

// A deterministic runner: instant fake solution echoing the challenge salt (no hashing).
const instantRunner: PowRunner = (challenge) =>
  Promise.resolve({ pow_salt: challenge.salt, pow_nonce: "n0", attempts: 1 });

test("no PoW demanded: exactly one request, zero challenge fetches (acceptance №6)", async () => {
  const h = harness([() => ({ user: "ok" })]);
  const result = await executeWithPow((pow) => h.exec(pow), {
    fetchChallenge: () => h.fetchChallenge(),
    runner: instantRunner,
  });
  assert.deepEqual(result, { user: "ok" });
  assert.equal(h.execCalls.length, 1);
  assert.equal(h.execCalls[0], undefined); // the bare request carries no pow fields
  assert.equal(h.challenges.length, 0); // /v1/auth/pow never touched
});

test("non-PoW errors surface as-is without touching the challenge endpoint", async () => {
  const boom = new ApiError("USERNAME_TAKEN", "taken", 409);
  const h = harness([() => { throw boom; }]);
  await assert.rejects(
    executeWithPow((pow) => h.exec(pow), { fetchChallenge: () => h.fetchChallenge(), runner: instantRunner }),
    (err: unknown) => err === boom,
  );
  assert.equal(h.execCalls.length, 1);
  assert.equal(h.challenges.length, 0);
});

test("POW_REQUIRED: one challenge fetch, one retry carrying {pow_salt,pow_nonce} (acceptance №1/№4)", async () => {
  const h = harness([
    () => { throw powRequired(); },
    (pow) => ({ ok: true, sawPow: pow }),
  ]);
  const result = (await executeWithPow((pow) => h.exec(pow), {
    fetchChallenge: () => h.fetchChallenge(),
    runner: instantRunner,
  })) as { sawPow?: PowWire };
  assert.equal(h.challenges.length, 1); // exactly ONE fetch of /v1/auth/pow
  assert.equal(h.execCalls.length, 2); // bare + exactly ONE retry
  assert.deepEqual(h.execCalls[1], { pow_salt: h.challenges[0]!.salt, pow_nonce: "n0" });
  assert.deepEqual(result.sawPow, { pow_salt: h.challenges[0]!.salt, pow_nonce: "n0" });
});

test("POW_INVALID on the retry: exactly one fresh challenge, then the error surfaces (acceptance №5)", async () => {
  const h = harness([
    () => { throw powRequired(); },
    () => { throw powInvalid(); }, // first solution rejected (e.g. salt raced the TTL)
    () => { throw powInvalid(); }, // second solution rejected too → give up
  ]);
  await assert.rejects(
    executeWithPow((pow) => h.exec(pow), { fetchChallenge: () => h.fetchChallenge(), runner: instantRunner }),
    (err: unknown) => err instanceof ApiError && err.code === "POW_INVALID",
  );
  assert.equal(h.challenges.length, 2); // original + exactly ONE fresh challenge — never a third
  assert.equal(h.execCalls.length, 3); // bare + one retry per challenge
  assert.deepEqual(h.execCalls[1], { pow_salt: h.challenges[0]!.salt, pow_nonce: "n0" });
  assert.deepEqual(h.execCalls[2], { pow_salt: h.challenges[1]!.salt, pow_nonce: "n0" });
});

test("POW_INVALID then success: the fresh challenge round recovers", async () => {
  const h = harness([
    () => { throw powRequired(); },
    () => { throw powInvalid(); },
    () => ({ ok: true }),
  ]);
  const result = await executeWithPow((pow) => h.exec(pow), {
    fetchChallenge: () => h.fetchChallenge(),
    runner: instantRunner,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(h.challenges.length, 2);
  assert.equal(h.execCalls.length, 3);
});

test("challenge expires mid-solve: one fresh challenge, a second expiry surfaces (acceptance №5)", async () => {
  const h = harness([() => { throw powRequired(); }]);
  let solverCalls = 0;
  const expiringRunner: PowRunner = () => { solverCalls++; return Promise.reject(new PowExpiredError()); };
  await assert.rejects(
    executeWithPow((pow) => h.exec(pow), { fetchChallenge: () => h.fetchChallenge(), runner: expiringRunner }),
    (err: unknown) => (err as Error).name === "PowExpiredError",
  );
  assert.equal(h.challenges.length, 2); // retry the fetch exactly once for an expiry
  assert.equal(solverCalls, 2);
  assert.equal(h.execCalls.length, 1); // no solution was ever produced → no retry request
});

test("abort mid-solve: PowAbortedError, no retry request (acceptance №3)", async () => {
  const h = harness([() => { throw powRequired(); }]);
  const ac = new AbortController();
  // A runner that aborts the flow while "working" — models the user leaving the screen mid-solve.
  const abortingRunner: PowRunner = (_c, opts) =>
    new Promise<PowSolution>((_res, rej) => {
      ac.abort();
      const err = new PowAbortedError();
      if (opts.signal?.aborted) rej(err);
      else rej(new Error("signal was not threaded through"));
    });
  await assert.rejects(
    executeWithPow((pow) => h.exec(pow), {
      fetchChallenge: () => h.fetchChallenge(),
      runner: abortingRunner,
      signal: ac.signal,
    }),
    (err: unknown) => err instanceof PowAbortedError,
  );
  assert.equal(h.execCalls.length, 1); // only the bare request — abort stopped everything after
  assert.equal(h.challenges.length, 1);
});

test("abort before the challenge fetch: no fetch happens at all", async () => {
  const h = harness([() => { throw powRequired(); }]);
  const ac = new AbortController();
  await assert.rejects(
    executeWithPow(
      (pow) => h.exec(pow).finally(() => ac.abort()), // aborted right as the bare request settles
      { fetchChallenge: () => h.fetchChallenge(), runner: instantRunner, signal: ac.signal },
    ),
    (err: unknown) => err instanceof PowAbortedError,
  );
  assert.equal(h.execCalls.length, 1);
  assert.equal(h.challenges.length, 0); // the gate checked the signal before fetching
});

test("onProgress is forwarded to the runner", async () => {
  const h = harness([() => { throw powRequired(); }, () => ({ ok: true })]);
  const seen: number[] = [];
  const progressRunner: PowRunner = (challenge, opts) => {
    opts.onProgress?.(64);
    opts.onProgress?.(128);
    return Promise.resolve({ pow_salt: challenge.salt, pow_nonce: "n0", attempts: 128 });
  };
  await executeWithPow((pow) => h.exec(pow), {
    fetchChallenge: () => h.fetchChallenge(),
    runner: progressRunner,
    onProgress: (attempts) => seen.push(attempts),
  });
  assert.deepEqual(seen, [64, 128]);
});

test("default runner is the real solver: solves a bits=1 challenge without injection", async () => {
  const h = harness([
    () => { throw powRequired(); },
    (pow) => ({ ok: true, pow }),
  ]);
  const result = (await executeWithPow((pow) => h.exec(pow), {
    fetchChallenge: () => h.fetchChallenge(),
  })) as { pow?: PowWire };
  assert.equal(result.pow?.pow_salt, h.challenges[0]!.salt);
  assert.ok(typeof result.pow?.pow_nonce === "string" && result.pow.pow_nonce.length > 0);
});

// ---------------------------------------------------- integration half (real server, GC_POW=1)

// Acceptance №7 in CI scope: a REAL scratch server with the flag ON. The register flow goes through
// the gate exactly as the ui Session does: bare POST → 400 POW_REQUIRED → GET /v1/auth/pow → solve
// (bits=8 keeps it instant) → retried POST succeeds. Full browser E2E stays out of scope here.
test("live GC_POW=1: register end-to-end through the gate; reused salt is refused", async (t) => {
  let srv: LiveServer;
  try {
    srv = await startLiveServer({ GC_POW: "1", GC_POW_BITS: "8" });
  } catch (err) {
    t.skip(`live server unavailable: ${(err as Error).message}`);
    return;
  }
  try {
    const post = async (path: string, body: Record<string, unknown>) => {
      const res = await fetch(srv.base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = (await res.json()) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
      if (!parsed.ok) throw new ApiError(parsed.error!.code, parsed.error!.message, res.status);
      return parsed.result;
    };
    const fetchChallenge = async () => {
      const res = await fetch(srv.base + "/v1/auth/pow");
      return ((await res.json()) as { result: PowChallenge }).result;
    };

    // Sanity: the bare register is refused with POW_REQUIRED (the flag is really on).
    const fields = {
      username: `powgate${Date.now().toString(36)}`,
      password: "password1!",
      name: "Pow Gate",
      legal_accepted: true,
      age_confirmed: true,
    };
    await assert.rejects(
      post("/v1/auth/register", fields),
      (err: unknown) => err instanceof ApiError && err.code === "POW_REQUIRED",
    );

    // The gate solves and retries: register succeeds end-to-end.
    let challengeFetches = 0;
    let lastWire: PowWire | undefined;
    const result = (await executeWithPow(
      (pow) => {
        lastWire = pow;
        return post("/v1/auth/register", { ...fields, ...(pow ?? {}) });
      },
      {
        fetchChallenge: () => { challengeFetches++; return fetchChallenge(); },
      },
    )) as { user: { username: string } };
    assert.equal(result.user.username, fields.username);
    assert.equal(challengeFetches, 1); // acceptance №1 against the real server
    assert.ok(lastWire?.pow_salt && lastWire?.pow_nonce);

    // Single-use salt: replaying the SAME solved pair for another account → POW_INVALID (twice —
    // the gate fetches one fresh challenge, we sabotage it by replaying the spent pair again).
    await assert.rejects(
      executeWithPow(
        () => post("/v1/auth/register", { ...fields, username: fields.username + "b", ...lastWire! }),
        { fetchChallenge },
      ),
      (err: unknown) => err instanceof ApiError && err.code === "POW_INVALID",
    );
  } finally {
    await srv.teardown();
  }
});
