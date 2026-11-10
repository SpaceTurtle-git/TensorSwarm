/** @type {import('next').NextConfig} */
//
// Two ways to run the dashboard:
//
//   npm run dev / npm start    Next.js server with the /api/* proxy (app/api/[...path]/route.ts)
//                              that forwards to MASTER_API_URL. Needs Node on that PC.
//
//   npm run build:static       Static export (TS_STATIC_EXPORT=1) copied to ../master/dashboard.
//                              The Master's FastAPI serves it at http://<MASTER_IP>:8000, so every
//                              PC on the tailnet can open the dashboard with just a browser.
//                              The browser then calls /api/v1/* on the same origin (FastAPI itself).
//
const staticExport = process.env.TS_STATIC_EXPORT === "1";

module.exports = staticExport
  ? {
      output: "export",
      // /notebook -> notebook/index.html, which FastAPI's StaticFiles serves as a folder index.
      trailingSlash: true,
      // The proxy route handler (app/api) cannot be exported and is not needed here:
      // build-static.js moves it aside for the duration of this build.
      images: { unoptimized: true },
    }
  : {};
