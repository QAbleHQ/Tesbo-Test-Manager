import { createHash } from "crypto";
import { ApiTokenService } from "./api-token.service";
import { DatabaseService } from "../database/database.service";

// Nest's HttpException keeps the { error } body on `.response`; `.message` is only the class name.
const refusal = (pattern: RegExp) => ({ response: { error: expect.stringMatching(pattern) } });

function makeDb(rows: Record<string, unknown>[] = [], rowCount?: number) {
  const query = jest.fn().mockResolvedValue({ rows, rowCount: rowCount ?? rows.length });
  return { db: { query } as unknown as DatabaseService, query };
}

describe("ApiTokenService", () => {
  describe("hashToken", () => {
    it("produces a stable 64-char sha256 hex digest", () => {
      const { db } = makeDb();
      const svc = new ApiTokenService(db);
      const hash = svc.hashToken("tsbo_abc");
      expect(hash).toHaveLength(64);
      expect(hash).toBe(createHash("sha256").update("tsbo_abc", "utf8").digest("hex"));
      expect(svc.hashToken("tsbo_abc")).toBe(hash); // deterministic
    });
  });

  describe("generateRawToken", () => {
    it("returns prefixed, high-entropy, unique tokens", () => {
      const { db } = makeDb();
      const svc = new ApiTokenService(db);
      const a = svc.generateRawToken();
      const b = svc.generateRawToken();
      expect(a).toMatch(/^tsbo_[0-9a-f]{48}$/);
      expect(a).not.toBe(b);
    });
  });

  describe("issueToken", () => {
    it("stores only the hash and returns the raw token exactly once", async () => {
      const created = new Date().toISOString();
      const { db, query } = makeDb([
        { id: "tok-1", name: "CI", scopes: "read,write", token_hash: "f".repeat(64), last_used_at: null, created_at: created }
      ]);
      const svc = new ApiTokenService(db);
      const result = await svc.issueToken("user-1", "proj-1", "CI", "read,write");

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain("INSERT INTO api_tokens");
      // Params: [userId, projectId, name, tokenHash, scopes]
      expect(params[0]).toBe("user-1");
      expect(params[1]).toBe("proj-1");
      expect(params[3]).toBe(svc.hashToken(result.token)); // hash matches raw
      expect(params[3]).not.toBe(result.token); // raw never stored
      expect(result.token).toMatch(/^tsbo_/);
      expect(result.scopes).toEqual(["read", "write"]);
    });

    const tokenRow = { id: "t", name: "n", scopes: "read,write", token_hash: "a".repeat(64), last_used_at: null, created_at: "now", expires_at: "later" };

    it("defaults to read+write when no scopes are supplied", async () => {
      for (const absent of [undefined, null, "", [], " , "]) {
        const { db, query } = makeDb([tokenRow]);
        await new ApiTokenService(db).issueToken("u", "p", "n", absent);
        expect(query.mock.calls[0][1][4]).toBe("read,write");
      }
    });

    it("refuses a scope that is not read or write instead of quietly granting read+write", async () => {
      // This used to fall back to read+write, so a typo or an attempt at "admin" got MORE than asked.
      for (const bad of ["bogus,delete", "admin", ["reed"], "read,admin"]) {
        const { db, query } = makeDb([tokenRow]);
        await expect(new ApiTokenService(db).issueToken("u", "p", "n", bad)).rejects.toMatchObject(refusal(/Unknown scope/));
        expect(query).not.toHaveBeenCalled();
      }
    });

    it("normalises case and duplicates", async () => {
      const { db, query } = makeDb([tokenRow]);
      await new ApiTokenService(db).issueToken("u", "p", "n", [" READ ", "read"]);
      expect(query.mock.calls[0][1][4]).toBe("read");
    });

    it("expires in 90 days unless told otherwise", async () => {
      const { db, query } = makeDb([tokenRow]);
      await new ApiTokenService(db).issueToken("u", "p", "n");
      expect(query.mock.calls[0][1][5]).toBe(90);
    });

    it("accepts 1 to 365 days, as a number or a numeric string", async () => {
      for (const [input, expected] of [[1, 1], [365, 365], ["30", 30], [" 7 ", 7]] as const) {
        const { db, query } = makeDb([tokenRow]);
        await new ApiTokenService(db).issueToken("u", "p", "n", undefined, input);
        expect(query.mock.calls[0][1][5]).toBe(expected);
      }
    });

    it("refuses an expiry that is zero, negative, fractional, too long or not a number", async () => {
      for (const bad of [0, -1, 1.5, 366, 10_000, "abc", NaN, Infinity, {}, [], true]) {
        const { db, query } = makeDb([tokenRow]);
        await expect(new ApiTokenService(db).issueToken("u", "p", "n", undefined, bad)).rejects.toMatchObject(refusal(/expiresInDays/));
        expect(query).not.toHaveBeenCalled();
      }
    });

    it("refuses a name longer than the column instead of surfacing a Postgres 500", async () => {
      const { db, query } = makeDb([tokenRow]);
      await expect(new ApiTokenService(db).issueToken("u", "p", "x".repeat(129))).rejects.toMatchObject(refusal(/at most 128/));
      expect(query).not.toHaveBeenCalled();
      await expect(new ApiTokenService(makeDb([tokenRow]).db).issueToken("u", "p", "x".repeat(128))).resolves.toBeTruthy();
    });

    it("answers 409 when the project already has the maximum active tokens (the INSERT returns no row)", async () => {
      const { db, query } = makeDb([]);
      await expect(new ApiTokenService(db).issueToken("u", "p", "n")).rejects.toMatchObject(refusal(/25 active API tokens/));
      // The cap lives in the same statement as the insert, so there is no count-then-insert gap.
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toMatch(/INSERT INTO api_tokens[\s\S]*WHERE \(SELECT count\(\*\)/);
      expect(query.mock.calls[0][1][6]).toBe(25);
    });

    it("counts only unexpired tokens against the cap, so expired ones never block a new one", async () => {
      const { db, query } = makeDb([tokenRow]);
      await new ApiTokenService(db).issueToken("u", "p", "n");
      expect(query.mock.calls[0][0]).toMatch(/expires_at IS NULL OR expires_at > now\(\)/);
    });

    it("returns the expiry with the summary", async () => {
      const { db } = makeDb([tokenRow]);
      expect((await new ApiTokenService(db).issueToken("u", "p", "n")).expiresAt).toBe("later");
    });
  });

  describe("revokeToken", () => {
    it("reports true when a row is deleted and false otherwise", async () => {
      const del = makeDb([], 1);
      expect(await new ApiTokenService(del.db).revokeToken("p", "t")).toBe(true);
      const none = makeDb([], 0);
      expect(await new ApiTokenService(none.db).revokeToken("p", "t")).toBe(false);
    });
  });

  describe("authenticate", () => {
    it("returns null for blank tokens without hitting the db", async () => {
      const { db, query } = makeDb();
      const svc = new ApiTokenService(db);
      expect(await svc.authenticate("")).toBeNull();
      expect(await svc.authenticate(null)).toBeNull();
      expect(query).not.toHaveBeenCalled();
    });

    it("returns null when no matching token row exists", async () => {
      const { db } = makeDb([]);
      expect(await new ApiTokenService(db).authenticate("tsbo_missing")).toBeNull();
    });

    it("only accepts a token that is unexpired, whose user is still on an unarchived project", async () => {
      const { db, query } = makeDb([]);
      await new ApiTokenService(db).authenticate("tsbo_x");
      const sql = query.mock.calls[0][0] as string;
      // Expiry, membership and archive state are all decided in the lookup, so there is no path that
      // authenticates first and checks later.
      expect(sql).toMatch(/expires_at IS NULL OR t\.expires_at > now\(\)/);
      expect(sql).toMatch(/JOIN project_members pm ON pm\.project_id = t\.project_id AND pm\.user_id = t\.user_id/);
      expect(sql).toMatch(/JOIN projects p ON p\.id = t\.project_id AND p\.archived_at IS NULL/);
    });

    it("does not stamp last_used_at for a token that failed to authenticate", async () => {
      const { db, query } = makeDb([]);
      await new ApiTokenService(db).authenticate("tsbo_expired");
      expect(query).toHaveBeenCalledTimes(1);
    });

    it("maps a matching row to a principal and stamps last_used_at", async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({
          rows: [{ id: "tok-9", user_id: "user-9", project_id: "proj-9", scopes: "read,write" }],
          rowCount: 1
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });
      const svc = new ApiTokenService({ query } as unknown as DatabaseService);

      const principal = await svc.authenticate("tsbo_secret");
      expect(principal).toEqual({
        tokenId: "tok-9",
        userId: "user-9",
        projectId: "proj-9",
        scopes: ["read", "write"]
      });
      // Looks up by the hash of the presented token.
      expect(query.mock.calls[0][1][0]).toBe(svc.hashToken("tsbo_secret"));
      // Second call updates usage.
      expect(query.mock.calls[1][0]).toContain("UPDATE api_tokens SET last_used_at");
    });
  });
});
