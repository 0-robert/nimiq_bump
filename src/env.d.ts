interface Env {
  SLOT: DurableObjectNamespace;
  ASSETS: Fetcher;
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  NETWORK_ID: string;
  RPC_URL: string;
  FLOOR_NIM: string;
  ROUND_SECONDS: string;
  CLAIM_SECONDS: string;
  GENESIS_ADDRESS: string;
}
