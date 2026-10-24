import { synthesizeText, buildSynthParams, jsonResponse } from "../lib/synth.js";

/**
 * 诊断入口，返回 JSON 而不是音频，方便部署后确认是否真的出声。
 * 用法：/api/debug?t=测试&v=zh-CN-XiaoxiaoNeural
 * 正常应看到 bytes > 0 且 headHex = fff364（标准 MP3 帧头）。
 */

export default async function onRequest(context) {
  const started = Date.now();
  try {
    const url = new URL(context.request.url);
    const params = url.searchParams;
    const text = String(params.get("t") || params.get("text") || "你好，这是 Edge TTS 自检。").trim();
    const body = buildSynthParams(params);
    const result = await synthesizeText(text, body);

    return jsonResponse({
      ok: result.bytes > 0,
      voice: body.voice,
      rate: body.rate,
      pitch: body.pitch,
      bytes: result.bytes,
      chunks: result.chunks,
      reason: result.reasons.join(","),
      truncated: result.truncated,
      headHex: result.audio.length >= 3 ? result.audio.subarray(0, 3).toString("hex") : "",
      elapsedMs: Date.now() - started,
      hint:
        result.bytes > 0
          ? "出声了。headHex 应为 fff364"
          : "未出声：多为握手失败（403 = 签名算法过期），或发音人不在服务端清单里",
      textSample: text.slice(0, 30),
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err && err.message ? err.message : String(err) }, 500);
  }
}
