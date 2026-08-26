import { readdir, readFile } from "node:fs/promises";

const SDRPLAY_VENDOR_ID = "1df7";

export async function detectSdrplayUsb(sysfsRoot = "/sys/bus/usb/devices"): Promise<"present" | "absent" | "unknown"> {
  try {
    const entries = await readdir(sysfsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const vendor = await readFile(`${sysfsRoot}/${entry.name}/idVendor`, "utf8").catch(() => "");
      if (vendor.trim().toLowerCase() === SDRPLAY_VENDOR_ID) return "present";
    }
    return "absent";
  } catch {
    return "unknown";
  }
}
