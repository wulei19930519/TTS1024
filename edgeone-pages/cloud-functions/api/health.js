import { SEC_MS_GEC_VERSION } from "../lib/edge-drm.js";
import { jsonResponse } from "../lib/synth.js";

/** 健康检查：/api/health */

export default async function onRequest() {
  return jsonResponse({
    ok: true,
    runtime: "nodejs",
    nodeVersion: process.version,
    secMsGecVersion: SEC_MS_GEC_VERSION,
    region: process.env.TENCENTCLOUD_REGION || process.env.EO_REGION || "unknown",
  });
}
