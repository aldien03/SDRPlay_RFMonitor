/** Browser calls for the DGNSS report: upload (gzip + progress), generate, poll, config. */
import type { DgnssConfig, DgnssConfigResponse, DgnssReportList, DgnssReportSummary, DgnssUploadPreview, DgnssWindowRequest } from "../shared/dgnss";

export class DgnssApiError extends Error {
  constructor(message: string, readonly status: number, readonly fields?: Record<string, string>) {
    super(message);
  }
}

/** Nginx admits 6 MiB per request; the browser compresses SBS text about 10x first. */
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024 - 64 * 1024;

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string; fields?: Record<string, string> };
    throw new DgnssApiError(payload.error ?? (response.status === 413 ? "The file is too large. Export up to 24 h from Gator." : "The request failed. Try again."), response.status, payload.fields);
  }
  return response.json() as Promise<T>;
}

async function compress(file: File): Promise<Blob> {
  if (typeof CompressionStream === "undefined") {
    if (file.size > MAX_UPLOAD_BYTES) throw new DgnssApiError("This browser cannot compress the file. Use Chrome, Edge or Firefox, or export a shorter period.", 0);
    return file;
  }
  const stream = file.stream().pipeThrough(new CompressionStream("gzip"));
  const blob = await new Response(stream).blob();
  if (blob.size > MAX_UPLOAD_BYTES) throw new DgnssApiError("The file is too large. Export up to 24 h from Gator.", 413);
  return blob;
}

/** Uploads an SBS file; progress goes 0 to 1 while bytes are sent. */
export async function uploadSbs(file: File, onProgress: (fraction: number) => void): Promise<DgnssUploadPreview> {
  const body = await compress(file);
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/dgnss/uploads");
    request.withCredentials = true;
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      let payload: { error?: string; fields?: Record<string, string> } & Partial<DgnssUploadPreview> = {};
      try {
        payload = JSON.parse(request.responseText) as typeof payload;
      } catch {
        // Keep the generic message below.
      }
      if (request.status >= 200 && request.status < 300) resolve(payload as DgnssUploadPreview);
      else reject(new DgnssApiError(payload.error ?? (request.status === 413 ? "The file is too large. Export up to 24 h from Gator." : "The upload failed. Try again."), request.status, payload.fields));
    };
    request.onerror = () => reject(new DgnssApiError("The connection to RF Monitor was lost. Try again.", 0));
    request.send(body);
  });
}

export const getDgnssConfig = async () => json<DgnssConfigResponse>(await fetch("/api/dgnss/config", { credentials: "same-origin" }));

export const saveDgnssConfig = async (config: Omit<DgnssConfig, "schemaVersion" | "revision" | "updatedAt">, expectedRevision: number) => json<DgnssConfigResponse>(await fetch("/api/dgnss/config", {
  method: "PUT",
  credentials: "same-origin",
  headers: { "content-type": "application/json", "x-rf-monitor-csrf": "settings-v1" },
  body: JSON.stringify({ config, expectedRevision }),
}));

export const generateDgnssReport = async (uploadId: string, window: DgnssWindowRequest) => json<DgnssReportSummary>(await fetch("/api/dgnss/reports", {
  method: "POST",
  credentials: "same-origin",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ uploadId, window }),
}));

export const getDgnssReport = async (id: string) => json<DgnssReportSummary>(await fetch(`/api/dgnss/reports/${encodeURIComponent(id)}`, { credentials: "same-origin" }));

export const listDgnssReports = async () => json<DgnssReportList>(await fetch("/api/dgnss/reports", { credentials: "same-origin" }));

export const cancelDgnssReport = async (id: string) => json<DgnssReportSummary>(await fetch(`/api/dgnss/reports/${encodeURIComponent(id)}/cancel`, {
  method: "POST",
  credentials: "same-origin",
  headers: { "content-type": "application/json" },
  body: "{}",
}));

export function dgnssFileUrl(id: string, kind: "pdf" | "html" | "package", download = false): string {
  const file = kind === "pdf" ? "report.pdf" : kind === "html" ? "report.html" : "package.zip";
  return `/api/dgnss/reports/${encodeURIComponent(id)}/${file}${download ? "?download=1" : ""}`;
}
