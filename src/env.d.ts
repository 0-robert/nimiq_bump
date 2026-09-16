interface Env {
  SLOT: DurableObjectNamespace;
  ASSETS: Fetcher;
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  NETWORK_ID: string;
  RPC_URL: string;
  FLOOR_NIM: string;
  CLOSE_HOUR_UTC: string;
  CLAIM_SECONDS: string;
  GENESIS_ADDRESS: string;
}
