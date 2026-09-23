import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { mapLimit } from "../src/mail.js";

test("worker pool visits each item once, preserves order and limits concurrency", async () => {
  let active = 0;
  let peak = 0;
  const visited: number[] = [];
  const result = await mapLimit([0, 1, 2, 3, 4], 2, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    visited.push(item);
    await delay(item === 0 ? 10 : 1);
    active -= 1;
    return item * 2;
  });
  assert.deepEqual(result, [0, 2, 4, 6, 8]);
  assert.deepEqual(visited.toSorted(), [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.deepEqual(
    await mapLimit([], 2, async () => assert.fail("No work expected")),
    []
  );
});
