# Singapore source runner

This service executes the unstable public-HTML sources from the Singapore VPS while Cloudflare remains the control plane and evidence store.

- Allowed sources are fixed to AmiAmi's Japanese search API, Mercari's DPoP API, Rakuten Ichiba item pages, Surugaya, Yahoo Shopping, Yahoo Auctions, and Yahoo Fleamarket.
- Requests contain a source operation, never an arbitrary URL.
- ECDSA P-256 signatures reuse the existing Worker signing key; only the public verification key is deployed here.
- One in-memory queue with two execution pools: `heavy` (AmiAmi, which spawns a
  Python subprocess per request) runs 2 at a time; `http` (everything else, plain
  fetch) runs 24. Each pool has its own queue depth, so a saturated `heavy` pool
  returns `queue_full` for AmiAmi alone and never blocks the other sources.
- HTML sources try ordinary HTTP first. Chromium is launched only for a bounded 403/challenge fallback and is closed at the end of that job.
- Mercari is API-only: its allowlisted GET/POST requests never launch Chromium, and redirects are rejected because DPoP binds the exact method and URL.
- Browser contexts are anonymous and ephemeral; no login profile or `userDataDir` is persisted.
- Raw upstream responses are returned as bounded evidence and are separated from the normalized result by the Collector before persistence.
- Eligible business failures are also written to a bounded local incident spool. While
  a source is being repaired, new jobs for that source return
  `source_runner_repair_pending` without repeating the upstream request.

The public API is mounted by Caddy at `/source-runner/`:

- `GET healthz` returns liveness only (`service`, `version`); the source list and queue depth stay off the public surface and are read from the VPS logs.
- `POST v1/jobs` using scope `source-runner.job.create.v1`
- `POST v1/jobs/status` using scope `source-runner.job.read.v1`

The production unit binds Node only to `127.0.0.1:8788`, runs as `jpgr-runner`, caps memory at 1.7 GB, and leaves the existing Hermes gateway untouched.

## Business-task self-healing

`BUSINESS_REPAIR_DIR` points at
`/var/lib/jpgr-source-runner/business-repair`. A repairable failed task is
persisted there with its exact validated request, normalized error, and a
bounded set of upstream captures. Authentication failures, CAPTCHA/login
requirements, rate limits, cooldowns, and known legitimate no-result outcomes
do not request a code repair.

The root-owned EMT SRE controller first replays the exact task without changing
code. A transient failure therefore resolves without invoking an Agent. For a
persistent failure, Antigravity may edit only the Source Runner code plus the
single source adapter named by the incident. It cannot edit Animate,
Cloudflare, Vercel, credentials, or another source adapter. Every candidate is
typechecked, independently reviewed, transactionally backed up, deployed, and
then checked by replaying the exact task. If that succeeds, a root-owned suite
of three independent golden searches for the repaired source must also pass.
A failure at either gate restores the original files and hashes. The Agent
cannot modify the replay or golden-regression control-plane files.

After both verification gates pass, the same transaction patch is placed in a
durable root-only Git outbox. The controller applies it to `origin/main` only
when the repository file still matches either the transaction's original or
candidate hash; divergent files are blocked instead of overwritten. Git
availability never determines whether an already verified production recovery
is kept.

The Collector maps the repair state to a durable delayed retry. It does not
increment source/binding failure counters or emit the ordinary consecutive
failure alert while repair is in progress. Once the gate clears, the normal
production schedule obtains and persists a fresh result.

The service can probe Surugaya, but the production Collector does not currently select that route: both ordinary HTTP and one anonymous Playwright fallback returned 403 from the Singapore address during deployment verification. The active migration therefore covers the three Yahoo sources only.
# AmiAmi runtime

AmiAmi uses the same signed job API and the `heavy` execution pool, with a bounded Python
`curl_cffi` transport instead of browser rendering. Install
`python/requirements.txt` into an isolated virtual environment and set
`AMIAMI_PYTHON` to its Python executable. `AMIAMI_PROXY_URL` is optional and
belongs only in the runner environment; the verified production VPS works
without a proxy. Never send proxy credentials in job requests.

Search keeps the original Japanese query and omits `lang=eng`. Catalog IDs
remain stable when the cheapest used condition offer changes; explicit
`scode` lookups retain offer identity. Full JSON evidence and description
fields are retained; challenge HTML is represented by metadata only.
