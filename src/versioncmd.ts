import { existsSync, readFileSync } from "fs";
import { SERVICES, WILSON_CONFIG } from "./services";
import { VERSION } from "./version";

export async function cmdVersion(json: boolean): Promise<void> {
  const versions: Record<string, string> = { wilson: VERSION };

  for (const svc of SERVICES) {
    if (existsSync(svc.currentVersionFile)) {
      versions[svc.name] = readFileSync(svc.currentVersionFile, "utf-8").trim();
    } else {
      versions[svc.name] = "not installed";
    }
  }

  if (existsSync(WILSON_CONFIG.currentVersionFile)) {
    versions["wilson-installed"] = readFileSync(
      WILSON_CONFIG.currentVersionFile,
      "utf-8",
    ).trim();
  }

  if (json) {
    console.log(JSON.stringify(versions, null, 2));
    return;
  }

  console.log(`\nWilson:   ${VERSION}`);
  for (const svc of SERVICES) {
    const ver = versions[svc.name];
    console.log(`${svc.displayName.padEnd(9)} ${ver}`);
  }
  console.log();
}
