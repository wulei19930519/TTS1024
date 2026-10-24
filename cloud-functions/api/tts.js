import { synthesizeText, buildSynthParams, jsonResponse } from "../lib/synth.js";

/**
 * Node.js 云函数入口（文件即路由）
 *   路由  →  /api/tts
 *   方法  →  GET / POST
 *
 * 参数：
 *   t      要朗读的文本（必填）
 *   v      发音人，默认 zh-CN-XiaoxiaoNeural
 *   r      语速 -100 ~ 100
 *   p      音调 -100 ~ 100
 *   vol    音量相对值（0 为默认）
 *   token  若配置了环境变量 TTS_TOKEN，则必填
 */

export default async function onRequest(context) {
  try {
    const request = context.request;
    const url = new URL(request.url);

    let params = url.searchParams;
    if (request.method === "POST") {
      const raw = await request.text().catch(() => "");
      try {
        params = new URLSearchParams(raw);
      } catch (_) {
        /* body 不是 form 编码时退回 query */
      }
    }

    const expected = (context.env && context.env.TTS_TOKEN) || process.env.TTS_TOKEN || "";
    if (expected && params.get("token") !== expected) {
      return jsonResponse({ error: "invalid token" }, 401);
    }

    const text = String(params.get("t") || params.get("text") || "").trim();
    if (!text) {
      return jsonResponse({ error: "missing param: t (要朗读的文本)" }, 400);
    }

    const started = Date.now();
    const body = buildSynthParams(params);
    const result = await synthesizeText(text, body);

    if (!result.audio.length) {
      return jsonResponse(
        {
          error: "synthesis returned no audio",
          voice: body.voice,
          reasons: result.reasons,
        },
        502
      );
    }

    return new Response(new Uint8Array(result.audio), {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "public, max-age=86400",
        "X-Tts-Bytes": String(result.audio.length),
        "X-Tts-Chunks": String(result.chunks),
        "X-Tts-Voice": body.voice,
        "X-Tts-Reason": result.reasons.join(","),
        "X-Tts-Elapsed": String(Date.now() - started),
      },
    });
  } catch (err) {
    return jsonResponse({ error: err && err.message ? err.message : String(err) }, 500);
  }
}
