import https from "node:https";
import nodeCrypto from "node:crypto";
import {
  generateSecMsGec,
  dateToString,
  buildSsml,
  hex16,
  normalizeVoice,
  SEC_MS_GEC_VERSION,
  USER_AGENT,
  OUTPUT_FORMAT,
  WSS_BASE,
} from "./edge-drm.js";

/**
 * Edge TTS 传输层。
 *
 * 为什么不能直接复用 Cloudflare 那份代码：
 *   Workers 支持 `fetch(url, { headers: { Upgrade: "websocket" } })` 出站，
 *   而 Node 的 fetch 不支持 Upgrade。所以这里改用 node:https 自己做握手 + 收发帧。
 *   全程只用 Node 内置模块，不引入 npm 依赖，避免 EdgeOne Pages 构建环节出错。
 */

const ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const HANDSHAKE_TIMEOUT = 12000;

// EdgeOne 云函数默认单次最长 30s（可调到 120s），留出安全余量
export const TOTAL_BUDGET_MS = 24000;
const PER_CHUNK_TIMEOUT_MS = 15000;
// 音频收完后若这么久没新数据，就判定本块已结束（弥补微软不发 turn.end 的情况）
const IDLE_GRACE_MS = 1500;
const IDLE_CHECK_MS = 300;
export const MAX_TEXT_LENGTH = 1200;
const DEFAULT_MAX = 300;

/* ---------------- WebSocket 握手 ---------------- */

function buildUrl() {
  const connId = nodeCrypto.randomUUID().replace(/-/g, "");
  return `${WSS_BASE}&ConnectionId=${connId}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
}

function openWebSocket() {
  return new Promise((resolve, reject) => {
    const url = new URL(buildUrl());
    const req = https.request(
      {
        host: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: "GET",
        timeout: HANDSHAKE_TIMEOUT,
        headers: {
          Host: url.host,
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": nodeCrypto.randomBytes(16).toString("base64"),
          "Sec-WebSocket-Version": "13",
          Origin: ORIGIN,
          "User-Agent": USER_AGENT,
          Pragma: "no-cache",
          "Cache-Control": "no-cache",
          "Accept-Language": "en-US,en;q=0.9",
          Cookie: `muid=${hex16()};`,
        },
      },
      (res) => {
        // 没走 upgrade 分支说明握手被拒（403 / 401 等）
        res.resume();
        reject(new Error(`handshake rejected: HTTP ${res.statusCode}`));
      }
    );

    req.on("upgrade", (res, socket, head) => {
      socket.setNoDelay(true);
      resolve({ socket, leftover: Buffer.from(head || Buffer.alloc(0)) });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("handshake timeout")));
    req.end();
  });
}

/* ---------------- 帧编解码 ---------------- */

// 客户端 → 服务端的帧必须掩码，否则微软会直接断开
function encodeTextFrame(payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(14);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + opcode 1 (text)
  const mask = nodeCrypto.randomBytes(4);
  mask.copy(header, header.length - 4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, masked]);
}

// 服务端 → 客户端的帧不带掩码
function createFrameParser(onMessage) {
  let buf = Buffer.alloc(0);
  let fragOpcode = 0;
  let parts = [];
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (buf.length < offset + len) return;

      const payload = Buffer.from(buf.subarray(offset, offset + len));
      buf = buf.subarray(offset + len);

      if (opcode === 0x8) {
        onMessage({ type: "close", code: payload.length >= 2 ? payload.readUInt16BE(0) : 0 });
        return;
      }
      if (opcode === 0x9 || opcode === 0xa) continue; // ping / pong

      const realOp = opcode === 0x0 ? fragOpcode : opcode;
      parts.push(payload);
      if (fin) {
        const full = Buffer.concat(parts);
        parts = [];
        fragOpcode = 0;
        onMessage({ type: realOp === 0x1 ? "text" : "binary", data: full });
      } else {
        fragOpcode = realOp;
      }
    }
  };
}

/* ---------------- 单次会话合成 ---------------- */

export function synthesizeOnce(opts, onAudio, timeoutMs = PER_CHUNK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let socket = null;
    let settled = false;
    let bytes = 0;
    let detail = "";
    let lastAudioAt = 0;
    let idleTimer = null;

    // 微软偶尔不发 Path:turn.end，只等它会白等到超时。
    // 这里补一层「音频收完后空转即判定结束」的逻辑，又快又稳。
    idleTimer = setInterval(() => {
      if (settled || !bytes) return;
      if (Date.now() - lastAudioAt > IDLE_GRACE_MS) finish("idle");
    }, IDLE_CHECK_MS);

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(idleTimer);
      try {
        socket && socket.destroy();
      } catch (_) {}
      resolve({ bytes, reason, detail });
    };

    const timer = setTimeout(() => finish("timeout"), timeoutMs);

    (async () => {
      try {
        const conn = await openWebSocket();
        socket = conn.socket;

        const parse = createFrameParser((msg) => {
          if (msg.type === "text") {
            const s = msg.data.toString("utf8");
            if (s.includes("Path:turn.end")) finish("end");
            return;
          }
          if (msg.type === "binary") {
            const b = msg.data;
            if (b.length < 2) return;
            const headerLen = b.readUInt16BE(0);
            const header = b.subarray(2, 2 + headerLen).toString("utf8");
            if (header.includes("Path:audio")) {
              const audio = Buffer.from(b.subarray(2 + headerLen));
              if (audio.length) {
                bytes += audio.length;
                lastAudioAt = Date.now();
                try {
                  onAudio(audio);
                } catch (_) {}
              }
            } else if (header.includes("Path:turn.end")) {
              finish("end");
            } else if (header.includes("Path:error")) {
              detail = header.slice(0, 160);
            }
            return;
          }
          if (msg.type === "close") {
            detail = `close ${msg.code}`;
            finish("close");
          }
        });

        socket.on("data", parse);
        socket.on("end", () => finish("close"));
        socket.on("error", (e) => {
          detail = e && e.message ? e.message : "socket error";
          finish("error");
        });

        const ts = dateToString();
        socket.write(
          encodeTextFrame(
            `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
              `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`
          )
        );

        const requestId = nodeCrypto.randomUUID().replace(/-/g, "");
        socket.write(
          encodeTextFrame(
            `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n` +
              buildSsml(opts)
          )
        );

        if (conn.leftover.length) parse(conn.leftover);
      } catch (err) {
        detail = err && err.message ? err.message : String(err);
        finish("error");
      }
    })();
  });
}

/* ---------------- 文本切块 ---------------- */

export function splitText(text, max = DEFAULT_MAX) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  if (trimmed.length <= max) return [trimmed];

  const pieces = trimmed.split(/(?<=[。！？；!?;\n])/).filter((s) => s.trim());
  const out = [];
  let cur = "";
  for (const piece of pieces) {
    if (cur && (cur + piece).length > max) {
      out.push(cur);
      cur = piece;
    } else {
      cur += piece;
    }
    while (cur.length > max) {
      out.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/* ---------------- 参数处理 ---------------- */

const percentify = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "+0%";
  return `${n >= 0 ? "+" : ""}${Math.round(n)}%`;
};

const hzify = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "+0Hz";
  return `${n >= 0 ? "+" : ""}${Math.round(n)}Hz`;
};

export function buildSynthParams(params) {
  return {
    voice: normalizeVoice(params.get("v") || params.get("voice")),
    rate: percentify(params.get("r") ?? params.get("rate") ?? 0),
    pitch: hzify(params.get("p") ?? params.get("pitch") ?? 0),
    volume: percentify(params.get("vol") ?? params.get("volume") ?? 0),
  };
}

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** 把整段文本合成为一块 MP3，返回结果对象 */
export async function synthesizeText(text, body) {
  const started = Date.now();
  const chunks = splitText(String(text).slice(0, MAX_TEXT_LENGTH));
  const audioParts = [];
  let totalBytes = 0;
  const reasons = [];
  let truncated = false;

  for (const chunk of chunks) {
    let res = null;
    let part = [];

    // 网络抖动会让单块偶发超时/断连，重试一次基本都能救回来
    for (let attempt = 0; attempt < 2; attempt++) {
      const remainMs = TOTAL_BUDGET_MS - (Date.now() - started);
      if (remainMs <= 1500) {
        res = { bytes: 0, reason: "budget" };
        truncated = true;
        break;
      }
      part = [];
      res = await synthesizeOnce(
        { ...body, text: chunk },
        (buf) => part.push(buf),
        Math.min(PER_CHUNK_TIMEOUT_MS, remainMs)
      );
      if (res.reason === "end" || res.reason === "close") break;
      if (res.bytes > 0) break;
    }

    if (!res) continue;
    if (res.bytes > 0) audioParts.push(...part);
    totalBytes += res.bytes;
    reasons.push(res.reason);
    if (res.reason === "budget") break;
  }

  return {
    audio: Buffer.concat(audioParts),
    bytes: totalBytes,
    chunks: chunks.length,
    reasons,
    truncated,
  };
}
