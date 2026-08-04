import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeQrMatrix } from "../src/qr.ts";

test("local QR encoder creates a square Model 2 matrix with finder patterns", () => {
  const matrix = encodeQrMatrix("tg://login?token=AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY");
  assert.ok(matrix.length >= 21 && (matrix.length - 17) % 4 === 0);
  assert.ok(matrix.every((row) => row.length === matrix.length));
  const finder = (left: number, top: number): void => {
    for (let y = 0; y < 7; y += 1) for (let x = 0; x < 7; x += 1) {
      const expected = x === 0 || y === 0 || x === 6 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
      assert.equal(matrix[top + y]?.[left + x], expected, `finder ${left},${top} at ${x},${y}`);
    }
  };
  finder(0, 0);
  finder(matrix.length - 7, 0);
  finder(0, matrix.length - 7);
});

test("local QR encoder is deterministic, UTF-8 safe and bounded", () => {
  assert.deepEqual(encodeQrMatrix("Привет, GreenChat"), encodeQrMatrix("Привет, GreenChat"));
  assert.throws(() => encodeQrMatrix("x".repeat(2_000)), /too large/u);
});
