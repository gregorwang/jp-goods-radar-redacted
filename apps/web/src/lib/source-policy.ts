import "server-only";
import { getEnv } from "@/lib/cloudflare";
import {
  isRakutenSourceId,
  rakutenMonitoringEnabledForSource,
  type RakutenRuntimePolicy,
} from "@/lib/rakuten-policy";

interface SourceState {
  enabled: boolean;
  monitoringAllowed: boolean;
}

export async function sourcePolicy(): Promise<Map<string, SourceState>> {
  const env = getEnv();
  const rows = await env.DB.prepare("SELECT id,enabled FROM source_registry").all<{ id: string; enabled: number }>();
  let rakutenPolicy: RakutenRuntimePolicy = {};
  let amazonMonitoringEnabled = false;
  let yahooAuctionsExperimentalEnabled = false;
  try {
    const response = await env.COLLECTOR.fetch("http://collector/internal/source-status");
    if (response.ok) {
      const body = await response.json() as {
        rakuten?: RakutenRuntimePolicy;
        amazon?: { monitoringEnabled?: boolean };
        yahooAuctions?: { experimentalEnabled?: boolean };
      };
      rakutenPolicy = body.rakuten ?? {};
      amazonMonitoringEnabled = body.amazon?.monitoringEnabled === true;
      yahooAuctionsExperimentalEnabled = body.yahooAuctions?.experimentalEnabled === true;
    }
  } catch {
    // Failing closed keeps Rakuten private monitoring paused when runtime state is unavailable.
  }
  return new Map(rows.results.map((row) => {
    const enabled = row.enabled === 1;
    const rakutenAllowed = !isRakutenSourceId(row.id) || rakutenMonitoringEnabledForSource(row.id, rakutenPolicy);
    const monitoringAllowed = enabled && rakutenAllowed
      && (row.id !== "amazon_jp" || amazonMonitoringEnabled)
      && (row.id !== "yahoo_auctions_jp" || yahooAuctionsExperimentalEnabled);
    return [row.id, { enabled, monitoringAllowed }];
  }));
}
