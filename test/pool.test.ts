import { describe, expect, it } from "vitest";
import { Pool } from "../src/extract/run.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("Pool", () => {
  it("runs at most `limit` jobs at a time and finishes them all", async () => {
    const pool = new Pool(2);
    let running = 0;
    let most = 0;
    const job = async () => {
      running++;
      most = Math.max(most, running);
      await tick();
      running--;
    };
    await Promise.all(Array.from({ length: 7 }, () => pool.run(job)));
    expect(most).toBe(2);
  });

  it("lets the lowest priority number wait least, and keeps the order of equal priorities", async () => {
    const pool = new Pool(1);
    const order: string[] = [];
    const named = (name: string, priority: number) =>
      pool.run(async () => {
        order.push(name);
        await tick();
      }, priority);
    // The first job takes the only place; the rest queue up and are served by priority.
    await Promise.all([named("first", 2), named("late-a", 2), named("urgent", 0), named("middle", 1), named("late-b", 2), named("urgent-2", 0)]);
    expect(order).toEqual(["first", "urgent", "urgent-2", "middle", "late-a", "late-b"]);
  });

  it("passes on what a job returns or throws, and frees its place either way", async () => {
    const pool = new Pool(1);
    await expect(pool.run(async () => 42)).resolves.toBe(42);
    await expect(pool.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(pool.run(async () => "after")).resolves.toBe("after");
  });
});
