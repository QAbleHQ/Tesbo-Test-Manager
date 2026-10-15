import type { Pool } from "pg";
import { DatabaseService } from "./database.service";

/*
 * heavyQuery() caps how many analytical reads hold a connection at once, so a burst of dashboard and
 * activity loads cannot take the whole pool and starve light requests. Unit-level on purpose: whether
 * the cap holds is a property of this class, and observing it end to end would need a database slow
 * enough to overlap on demand.
 */

interface Pending {
  sql: string;
  resolve: (value: { rows: unknown[] }) => void;
  reject: (error: Error) => void;
}

function fakePool(max: number) {
  const pending: Pending[] = [];
  let running = 0;
  let peak = 0;
  const pool = {
    options: { max },
    query: (sql: string) =>
      new Promise((resolve, reject) => {
        running++;
        peak = Math.max(peak, running);
        pending.push({
          sql,
          resolve: (value) => {
            running--;
            resolve(value);
          },
          reject: (error) => {
            running--;
            reject(error);
          }
        });
      })
  };
  return { pool: pool as unknown as Pool, pending, peak: () => peak, running: () => running };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("DatabaseService.heavyQuery", () => {
  it("lets a quarter of the pool run at once and queues the rest in arrival order", async () => {
    const fake = fakePool(8); // limit = 2
    const db = new DatabaseService(fake.pool);

    const results = ["a", "b", "c", "d", "e"].map((sql) => db.heavyQuery(sql));
    await tick();
    // only two may be in the database
    expect(fake.running()).toBe(2);
    expect(fake.pending.map((p) => p.sql)).toEqual(["a", "b"]);

    fake.pending[0].resolve({ rows: [] });
    await tick();
    // a finished, so c takes its place, and not more than that
    expect(fake.running()).toBe(2);
    expect(fake.pending.map((p) => p.sql)).toEqual(["a", "b", "c"]);

    fake.pending[1].resolve({ rows: [] });
    fake.pending[2].resolve({ rows: [] });
    await tick();
    expect(fake.pending.map((p) => p.sql)).toEqual(["a", "b", "c", "d", "e"]);
    fake.pending[3].resolve({ rows: [] });
    fake.pending[4].resolve({ rows: [] });
    await Promise.all(results);
    expect(fake.peak()).toBe(2);
  });

  it("frees the slot when a query fails, so one timeout cannot wedge every later read", async () => {
    const fake = fakePool(4); // limit = 1
    const db = new DatabaseService(fake.pool);

    const first = db.heavyQuery("slow");
    const second = db.heavyQuery("next");
    await tick();
    expect(fake.pending.map((p) => p.sql)).toEqual(["slow"]);

    fake.pending[0].reject(new Error("canceling statement due to statement timeout"));
    await expect(first).rejects.toThrow("statement timeout");
    await tick();
    // the queued read ran after the failure
    expect(fake.pending.map((p) => p.sql)).toEqual(["slow", "next"]);
    fake.pending[1].resolve({ rows: [] });
    await expect(second).resolves.toEqual({ rows: [] });
  });

  it("never gates a light query, even while every heavy slot is taken", async () => {
    const fake = fakePool(4); // limit = 1
    const db = new DatabaseService(fake.pool);

    void db.heavyQuery("heavy 1");
    void db.heavyQuery("heavy 2");
    const light = db.query("light");
    await tick();

    // the light query reached the pool beside the running heavy one; "heavy 2" is still waiting its turn.
    // (Sorted: a heavy call reaches the pool a microtask after a light one, so arrival order is not the point.)
    expect(fake.pending.map((p) => p.sql).sort()).toEqual(["heavy 1", "light"]);
    fake.pending.forEach((p) => p.resolve({ rows: [] }));
    await light;
  });

  it("always allows at least one, however small the pool", async () => {
    const fake = fakePool(1); // floor(1/4) = 0, raised to 1
    const db = new DatabaseService(fake.pool);

    const only = db.heavyQuery("only");
    await tick();
    expect(fake.running()).toBe(1);
    fake.pending[0].resolve({ rows: [] });
    await only;
  });
});
