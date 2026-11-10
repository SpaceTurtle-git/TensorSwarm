// Builds the dashboard as static files and copies them to ../master/dashboard, where the
// Master's FastAPI serves them on port 8000. Run on any PC with Node:  npm run build:static
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const here = __dirname;
const outDir = path.join(here, "out");
const target = path.resolve(here, "..", "master", "dashboard");

const nextBin = path.join(here, "node_modules", "next", "dist", "bin", "next");
if (!fs.existsSync(nextBin)) {
  console.error("Next.js is not installed here. Run:  npm install");
  process.exit(1);
}

// The /api proxy route cannot be statically exported (and FastAPI answers /api itself), so it
// is parked outside app/ during the build and always restored afterwards.
const apiDir = path.join(here, "app", "api");
const parked = path.join(here, ".api-parked");
if (fs.existsSync(parked) && !fs.existsSync(apiDir)) fs.renameSync(parked, apiDir); // recover an interrupted run

fs.rmSync(outDir, { recursive: true, force: true });
let result;
fs.renameSync(apiDir, parked);
try {
  result = spawnSync(process.execPath, [nextBin, "build"], {
    cwd: here,
    stdio: "inherit",
    env: { ...process.env, TS_STATIC_EXPORT: "1", NEXT_TELEMETRY_DISABLED: "1" },
  });
} finally {
  fs.renameSync(parked, apiDir);
}
if (result.status !== 0) process.exit(result.status || 1);

if (!fs.existsSync(path.join(outDir, "index.html"))) {
  console.error(`Static export did not produce ${path.join(outDir, "index.html")}`);
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(outDir, target, { recursive: true });
fs.writeFileSync(
  path.join(target, "BUILD_INFO.txt"),
  `Built ${new Date().toISOString()} by frontend/build-static.js. Do not edit; rebuild instead.\n`
);
fs.rmSync(outDir, { recursive: true, force: true });
console.log(`\nDashboard copied to ${target}`);
console.log("The Master serves it at http://<MASTER_IP>:8000");
