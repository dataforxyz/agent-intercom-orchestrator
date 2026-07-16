import { spawnSync } from "node:child_process";

export function systemdUserManagerAvailable(): boolean {
  return process.platform === "linux" && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status === 0;
}

export function systemdVersion(): number | undefined {
  const output = spawnSync("systemctl", ["--version"], { encoding: "utf8" });
  if (output.status !== 0) return undefined;
  const match = /^systemd\s+(\d+)/m.exec(output.stdout);
  return match ? Number(match[1]) : undefined;
}

export function supportsUserMountNamespaces(): boolean {
  if (!systemdUserManagerAvailable()) return false;
  const probe = spawnSync("systemd-run", [
    "--user", "--wait", "--pipe", "--quiet",
    "--property=ProtectSystem=strict",
    "/bin/true",
  ], { encoding: "utf8", timeout: 10_000 });
  return probe.status === 0;
}

export function supportsHardenedUserUnits(): boolean {
  const version = systemdVersion();
  if (version === undefined || version < 257 || !supportsUserMountNamespaces()) return false;
  const probe = spawnSync("systemd-run", [
    "--user", "--wait", "--pipe", "--quiet",
    "--property=PrivateUsers=self",
    "--property=PrivatePIDs=yes",
    "/bin/true",
  ], { encoding: "utf8", timeout: 10_000 });
  return probe.status === 0;
}
