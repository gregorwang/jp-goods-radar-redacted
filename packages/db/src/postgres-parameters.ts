/**
 * Number PostgreSQL bind parameters while preserving question marks inside
 * quoted SQL literals and identifiers.
 */
export function numberPostgresParameters(sql: string): string {
  let result = "";
  let parameter = 0;
  let singleQuoted = false;
  let doubleQuoted = false;

  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index]!;
    const next = sql[index + 1];

    if (singleQuoted) {
      result += current;
      if (current === "'" && next === "'") {
        result += next;
        index += 1;
      } else if (current === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (doubleQuoted) {
      result += current;
      if (current === '"' && next === '"') {
        result += next;
        index += 1;
      } else if (current === '"') {
        doubleQuoted = false;
      }
      continue;
    }
    if (current === "'") {
      singleQuoted = true;
      result += current;
      continue;
    }
    if (current === '"') {
      doubleQuoted = true;
      result += current;
      continue;
    }
    if (current === "?") {
      parameter += 1;
      result += `$${parameter}`;
      continue;
    }
    result += current;
  }

  return result;
}
