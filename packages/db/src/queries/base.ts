/**
 * 继承链的根：只持有数据库句柄。
 *
 * `db` 是 `protected` 而不是 `private`，因为各组的方法体原样保留了
 * `this.db`——这正是这次拆分不需要改动任何一行查询的原因。
 */
import type { OperationalDatabase } from "../database";

export abstract class RepositoryBase {
  constructor(protected readonly db: OperationalDatabase) {}
}
