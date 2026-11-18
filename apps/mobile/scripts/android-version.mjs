import { readFileSync } from "node:fs";

// android/app/build.gradle is the only place a release changes the version; the web build reads it.
export function parseAndroidVersion(gradle) {
  const name = gradle.match(/^\s*versionName\s+"([^"]+)"/mu)?.[1];
  const code = Number(gradle.match(/^\s*versionCode\s+(\d+)\s*$/mu)?.[1]);
  if (!name || !Number.isSafeInteger(code) || code < 1) throw new Error("build.gradle has no versionName/versionCode");
  return { name, code };
}

export function readAndroidVersion(gradleFile) {
  return parseAndroidVersion(readFileSync(gradleFile, "utf8"));
}
