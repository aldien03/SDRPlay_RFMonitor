import { loadConfig } from "./config";

try {
  const config = await loadConfig();
  console.log(JSON.stringify({
    valid: true,
    siteName: config.siteName,
    deploymentId: config.deploymentId,
    displayTimeZone: config.displayTimeZone,
    receiverUrls: config.receiverUrls,
    dataDomain: config.dataDomain,
    storageRoot: config.storageRoot,
    bandCount: config.bands.length,
    simulation: config.simulation,
    accessBoundary: "loopback backend with reverse-proxy network policy",
    configurationSources: config.configurationSources,
  }, null, 2));
} catch (error) {
  console.error(`RF Monitor configuration is invalid: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
