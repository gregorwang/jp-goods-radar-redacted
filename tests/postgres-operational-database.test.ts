import { describe, expect, it } from "vitest";
import { numberPostgresParameters } from "../packages/db/src/postgres";

describe("PostgreSQL operational parameters", () => {
  it("numbers bind placeholders without changing quoted question marks", () => {
    expect(numberPostgresParameters(
      `SELECT '?', "?", value FROM sample WHERE id=? AND note='it''s ?' AND other=?`,
    )).toBe(
      `SELECT '?', "?", value FROM sample WHERE id=$1 AND note='it''s ?' AND other=$2`,
    );
  });

  it("leaves native PostgreSQL syntax intact", () => {
    expect(numberPostgresParameters(
      "INSERT INTO sample(id) VALUES(?) ON CONFLICT DO NOTHING RETURNING id",
    )).toBe(
      "INSERT INTO sample(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id",
    );
  });
});
