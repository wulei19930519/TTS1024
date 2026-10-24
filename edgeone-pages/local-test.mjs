/**
 * 本地验收脚本：直接调用云函数处理器，不经过 EdgeOne。
 * 用法：node local-test.mjs
 */

import handler from "./cloud-functions/api/tts.js";
import debugHandler from "./cloud-functions/api/debug.js";
import rootHandler from "./cloud-functions/index.js";
import healthHandler from "./cloud-functions/api/health.js";

function makeContext(urlStr, method = "GET") {
  return {
    request: new Request(urlStr, { method }),
    env: {},
    params: {},
    clientIp: "127.0.0.1",
  };
}

async function call(label, urlStr) {
  const started = Date.now();
  const res = await handler(makeContext(urlStr));
  if ((res.headers.get("content-type") || "").includes("audio/mpeg")) {
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(
      `${label.padEnd(26)} bytes=${String(buf.length).padEnd(8)} head=${buf.subarray(0, 3).toString("hex")} ` +
        `voice=${res.headers.get("x-tts-voice")} chunks=${res.headers.get("x-tts-chunks")} ` +
        `reason=${res.headers.get("x-tts-reason")} ${Date.now() - started}ms`
    );
    return buf.length;
  }
  const body = await res.text();
  console.log(`${label.padEnd(26)} HTTP ${res.status} ${body.slice(0, 220)}`);
  return res.status === 200 ? 1 : 0;
}

const BASE = "http://local.test/api";
const enc = encodeURIComponent;
let failures = 0;

console.log("=== 本地验收（直接调用 EdgeOne 云函数处理器）===\n");

failures += (await call("短句 默认发音人", `${BASE}/tts?t=${enc("你好，这是本地验收测试。")}`)) ? 0 : 1;
failures += (await call("云希 + 语速 +20", `${BASE}/tts?t=${enc("前不见古人，后不见来者。")}&v=zh-CN-YunxiNeural&r=20&p=0`)) ? 0 : 1;
failures += (await call("已下线发音人(应兜底)", `${BASE}/tts?t=${enc("这是一个已下线发音人的兜底测试。")}&v=zh-CN-XiaomoNeural`)) ? 0 : 1;
failures += (await call("粤语发音人", `${BASE}/tts?t=${enc("粤语测试。")}&v=zh-HK-WanLungNeural`)) ? 0 : 1;
failures += (await call("英文发音人", `${BASE}/tts?t=${enc("Hello from local test.")}&v=en-US-AriaNeural`)) ? 0 : 1;

const long = "这是一个用来测试长文本自动分块处理的句子。".repeat(40);
failures += (await call(`长文本 ${long.length} 字`, `${BASE}/tts?t=${enc(long)}`)) ? 0 : 1;

console.log("\n--- 参数校验 ---");
await call("缺少文本参数", `${BASE}/tts`);

console.log("\n--- 其余路由 ---");
const hres = await healthHandler(makeContext(`${BASE}/health`));
console.log("/api/health".padEnd(26), await hres.text());
const rres = await rootHandler(makeContext("http://local.test/"));
const rbody = await rres.text();
console.log("/ 根路由".padEnd(26), `HTTP ${rres.status} type=${rres.headers.get("content-type")} bytes=${rbody.length}`);

console.log("\n--- /api/debug ---");
const dres = await debugHandler(makeContext(`${BASE}/debug?t=${enc("自检查看是否出声")}`));
const dbody = await dres.text();
console.log(dbody);

const parsed = JSON.parse(dbody);
const ok = parsed.ok === true && parsed.headHex === "fff364";
console.log(`\n最终结果：${ok ? "全部通过，代码可直接部署" : "存在失败项，检查上方输出"}`);
process.exit(ok && failures === 0 ? 0 : 1);
