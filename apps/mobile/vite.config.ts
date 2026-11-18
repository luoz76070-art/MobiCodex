import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readAndroidVersion } from "./scripts/android-version.mjs";

const version = readAndroidVersion(fileURLToPath(new URL("./android/app/build.gradle", import.meta.url)));

export default defineConfig({
  plugins: [react()],
  define: {
    __WEB_BUILD_ID__: JSON.stringify(`web-${randomUUID()}`),
    __APP_VERSION_NAME__: JSON.stringify(version.name),
    __APP_VERSION_CODE__: JSON.stringify(version.code),
  },
  server: {
    host: "0.0.0.0",
    port: 5178,
    allowedHosts: true,
  },
});
