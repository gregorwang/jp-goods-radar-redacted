/**
 * 部署闸门：把运行时 SQL 拿到真实 PostgreSQL 上预编译一遍。
 *
 * `validate-postgres-operational-sql.mjs` 生成校验脚本，这里负责把它送到生产库执行
 * 并把结果变成进程退出码——没有退出码，它就只是一个没人跑的脚本。
 *
 * 为什么必须连真库：Workers 侧写的是 `?` 占位符风格的 SQL，`postgres-parameters.ts`
 * 按位置改写成 `$n` 之后才交给 PostgreSQL。类型推断只在 PostgreSQL 的 PREPARE 阶段
 * 发生，本地 typecheck 和用假 D1 的单元测试都看不见它。2026-09-04 一条
 * `WHEN ? IS NULL` 就是这样过了所有检查、上线后让全部关键词采集连挂一夜
 * （42P08 could not determine data type of parameter $1）。这条语句在本脚本的覆盖
 * 范围内，跑一次只要几秒。
 *
 * 逃生舱：JPGR_SKIP_SQL_VERIFY=1（数据库不可达又必须发版时用，别当默认）。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SSH_TARGET = process.env.JPGR_DB_SSH_TARGET ?? "root@203.0.113.10";
const PSQL = process.env.JPGR_PSQL_COMMAND ?? "sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d jpgr";

if (process.env.JPGR_SKIP_SQL_VERIFY === "1") {
  process.stderr.write("JPGR_SKIP_SQL_VERIFY=1，跳过运行时 SQL 预编译校验\n");
  process.exit(0);
}

const generated = spawnSync(process.execPath, ["scripts/validate-postgres-operational-sql.mjs"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (generated.status !== 0) {
  process.stderr.write(generated.stderr || "无法生成 SQL 校验脚本\n");
  process.exit(1);
}
process.stderr.write(generated.stderr);

// 生成的脚本把失败逐条记进临时表并原样打印出来；没有这段断言，psql 会以 0 退出，
// 闸门就形同虚设。
const script = `${generated.stdout}
DO $verify_gate$
DECLARE failures integer;
BEGIN
  SELECT count(*) INTO failures FROM operational_sql_validation_errors;
  IF failures > 0 THEN
    RAISE EXCEPTION '% 条运行时 SQL 无法在 PostgreSQL 上预编译，见上表', failures;
  END IF;
END
$verify_gate$;
`;

const file = join(mkdtempSync(join(tmpdir(), "jpgr-sql-")), "operational-sql.sql");
writeFileSync(file, script, "utf8");

// 走 scp + `psql -f` 而不是把脚本喂进 ssh 的 stdin：这个校验脚本有近万行，
// Windows 下经 stdin 传这么大的输入会间歇性地以 "spawnSync ssh EOF" 断掉。
const remote = `/tmp/jpgr-operational-sql-${process.pid}.sql`;
const upload = spawnSync("scp", ["-q", file, `${SSH_TARGET}:${remote}`], { encoding: "utf8" });
if (upload.error || upload.status !== 0) {
  process.stderr.write(`无法上传校验脚本：${upload.error?.message ?? upload.stderr}\n`);
  process.stderr.write(`校验脚本已写入 ${file}\n`);
  process.exit(1);
}
const psql = spawnSync("ssh", [SSH_TARGET, `${PSQL} -f ${remote}; rc=$?; rm -f ${remote}; exit $rc`], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (psql.error) {
  process.stderr.write(`无法连接数据库执行校验：${psql.error.message}\n`);
  process.stderr.write(`校验脚本已写入 ${file}\n`);
  process.exit(1);
}
process.stdout.write(psql.stdout ?? "");
if (psql.status !== 0) {
  process.stderr.write(psql.stderr ?? "");
  process.stderr.write(`\n运行时 SQL 预编译校验未通过；校验脚本见 ${file}\n`);
  process.exit(psql.status ?? 1);
}
process.stderr.write("运行时 SQL 预编译校验通过\n");
