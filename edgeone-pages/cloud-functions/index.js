import { jsonResponse, synthesizeText, buildSynthParams } from "./lib/synth.js";
import { SEC_MS_GEC_VERSION } from "./lib/edge-drm.js";

/**
 * 根路由：浏览器直接打开时给一张说明页。
 * 真正干活的是 /api/tts。
 */

export default async function onRequest(context) {
  const url = new URL(context.request.url);

  if (url.searchParams.get("t")) {
    const body = buildSynthParams(url.searchParams);
    const result = await synthesizeText(url.searchParams.get("t"), body);
    if (!result.audio.length) {
      return jsonResponse({ error: "no audio", reasons: result.reasons }, 502);
    }
    return new Response(new Uint8Array(result.audio), {
      headers: { "Content-Type": "audio/mpeg", "X-Tts-Bytes": String(result.audio.length) },
    });
  }

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Edge TTS Proxy</title>
<style>body{padding:28px 20px;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#22262a;line-height:1.7;max-width:720px;margin:0 auto}
code{background:#f3f4f6;padding:2px 6px;border-radius:4px}table{border-collapse:collapse;margin:12px 0}
td,th{border:1px solid #e5e7eb;padding:6px 10px;text-align:left;font-size:14px}</style></head><body>
<h1>Edge TTS Proxy</h1>
<p>运行在 EdgeOne Pages 云函数，签名版本 ${SEC_MS_GEC_VERSION}。</p>
<table><tr><th>路径</th><th>说明</th></tr>
<tr><td><code>/api/tts?t=文本</code></td><td>合成语音，返回 audio/mpeg</td></tr>
<tr><td><code>/api/debug?t=测试</code></td><td>自检，headHex 应为 fff364</td></tr>
<tr><td><code>/api/health</code></td><td>健康检查</td></tr></table>
<p>参数：<code>t</code> 文本（必填）、<code>v</code> 发音人、<code>r</code> 语速、
<code>p</code> 音调、<code>vol</code> 音量、<code>token</code> 口令（若已配置）。</p>
</body></html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
