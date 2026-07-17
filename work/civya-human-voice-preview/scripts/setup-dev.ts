import { spawnSync } from "node:child_process";

function run(script: string): void {
  const result = spawnSync(process.execPath, ["--import", "tsx", script], {
    cwd: new URL("..", import.meta.url),
    stdio: "inherit",
    env: {
      ...process.env,
      CIVYA_ENVIRONMENT: process.env.CIVYA_ENVIRONMENT || "development",
      CIVYA_SYNTHETIC_MODE: process.env.CIVYA_SYNTHETIC_MODE || "true",
      CIVYA_CONFIG_VERSION: process.env.CIVYA_CONFIG_VERSION || "local-v1",
      CIVYA_RELEASE_VERSION: process.env.CIVYA_RELEASE_VERSION || "local",
    },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("scripts/doctor.ts");
run("scripts/golden-slice.ts");

console.log("\nLocal synthetic setup is ready.");
console.log("Resident: http://localhost:3000/");
console.log("Staff:    http://localhost:3000/staff/operations");
console.log("Start:    npm run dev");
console.log("Hosted providers remain disabled until their separate contract gates pass.");
