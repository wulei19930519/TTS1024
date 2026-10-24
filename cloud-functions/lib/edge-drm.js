/* ============================================================
 *  Edge TTS 鉴权（Sec-MS-GEC v2）
 *  从 Cloudflare 版本 worker.js 原样抽取，算法已在 4 组官方测试
 *  向量上逐字节校验一致，切勿随意改动。
 *  依赖的全局对象（crypto.randomUUID / crypto.getRandomValues /
 *  TextEncoder）在 Node 18+ 均原生可用。
 * ============================================================ */

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
// 注意：Workers 的 fetch 不接受 wss://，必须用 https:// + Upgrade 头
const WSS_BASE = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0`;
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const WIN_EPOCH = 11644473600n;

/* ============================================================
 *  DRM: Sec-MS-GEC v2 token
 * ============================================================ */

const U32 = 0xffffffff;

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
];

const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
];

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const SHA256_ADJUSTMENT = 0xc9dc06a7;
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;

// 第 14 轮常量被替换过的版本
const SHA256_BLOCK_CONSTANTS = SHA256_ROUND_CONSTANTS.slice(0, 14)
  .concat([SHA256_ADJUSTMENT])
  .concat(SHA256_ROUND_CONSTANTS.slice(15));

const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d], [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf], [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb], [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464], [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

const rotr = (x, n) => (((x >>> n) | (x << (32 - n))) >>> 0);
const rol16 = (v) => (((v << 16) | (v >>> 16)) >>> 0);
const imul = (a, b) => (Math.imul(a, b) >>> 0);
const bigSig1 = (x) => ((rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25)) >>> 0);
const bigSig0 = (x) => ((rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22)) >>> 0);
const sSigma0 = (v) => (((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3)) >>> 0);
const sSigma1 = (v) => (((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10)) >>> 0);

function wordsLe4Even(data) {
  const words = [];
  const padded = Math.ceil(data.length / 4) * 4;
  for (let i = 0; i < padded; i += 4) {
    const b0 = data[i] | 0;
    const b1 = (i + 1 < data.length ? data[i + 1] : 0) | 0;
    const b2 = (i + 2 < data.length ? data[i + 2] : 0) | 0;
    const b3 = (i + 3 < data.length ? data[i + 3] : 0) | 0;
    words.push(((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0);
  }
  if (words.length % 2) words.push(0);
  return words;
}

function sha256Rounds(state, words, firstRound) {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  const aligned = Math.min(64, Math.floor((firstRound + 7) / 8) * 8);

  for (let i = firstRound; i < aligned; i++) {
    const t1 = (h + bigSig1(e) + (g ^ (e & (f ^ g))) + constants[i] + words[i]) >>> 0;
    const t2 = (bigSig0(a) + ((a & b) | (c & (a | b)))) >>> 0;
    const oa = a, ob = b, oc = c, od = d, oe = e, of = f, og = g;
    a = (t1 + t2) >>> 0;
    b = oa;
    c = ob;
    d = oc;
    e = (od + t1) >>> 0;
    f = oe;
    g = of;
    h = og;
  }

  for (let i = aligned; i < 64; i += 8) {
    let t1 = (h + bigSig1(e) + (g ^ (e & (f ^ g))) + constants[i] + words[i]) >>> 0;
    d = (d + t1) >>> 0;
    h = (t1 + bigSig0(a) + ((a & b) | (c & (a | b)))) >>> 0;

    t1 = (g + bigSig1(d) + (f ^ (d & (e ^ f))) + constants[i + 1] + words[i + 1]) >>> 0;
    c = (c + t1) >>> 0;
    g = (t1 + bigSig0(h) + ((h & a) | (b & (h | a)))) >>> 0;

    t1 = (f + bigSig1(c) + (e ^ (c & (d ^ e))) + constants[i + 2] + words[i + 2]) >>> 0;
    b = (b + t1) >>> 0;
    f = (t1 + bigSig0(g) + ((g & h) | (a & (g | h)))) >>> 0;

    t1 = (e + bigSig1(b) + (d ^ (b & (c ^ d))) + constants[i + 3] + words[i + 3]) >>> 0;
    a = (a + t1) >>> 0;
    e = (t1 + bigSig0(f) + ((f & g) | (h & (f | g)))) >>> 0;

    t1 = (d + bigSig1(a) + (c ^ (a & (b ^ c))) + constants[i + 4] + words[i + 4]) >>> 0;
    h = (h + t1) >>> 0;
    d = (t1 + bigSig0(e) + ((e & f) | (g & (e | f)))) >>> 0;

    t1 = (c + bigSig1(h) + (b ^ (h & (a ^ b))) + constants[i + 5] + words[i + 5]) >>> 0;
    g = (g + t1) >>> 0;
    c = (t1 + bigSig0(d) + ((d & e) | (f & (d | e)))) >>> 0;

    t1 = (b + bigSig1(g) + (a ^ (g & (h ^ a))) + constants[i + 6] + words[i + 6]) >>> 0;
    f = (f + t1) >>> 0;
    b = (t1 + bigSig0(c) + ((c & d) | (e & (c | d)))) >>> 0;

    t1 = (a + bigSig1(f) + (h ^ (f & (g ^ h))) + constants[i + 7] + words[i + 7]) >>> 0;
    e = (e + t1) >>> 0;
    a = (t1 + bigSig0(b) + ((b & c) | (d & (b | c)))) >>> 0;
  }

  return [a, b, c, d, e, f, g, h];
}

function expandSchedule(words, firstWord) {
  for (let i = firstWord; i < 64; i++) {
    const x = words[i - 2];
    const y = words[i - 15];
    words.push((sSigma1(x) + words[i - 7] + sSigma0(y) + words[i - 16]) >>> 0);
  }
  return words;
}

function sha256Init(prefix) {
  const words = new Array(16).fill(0);
  words[14] = (((prefix[0] | 0) << 16) | ((prefix[1] | 0) << 8) | (prefix[2] | 0)) >>> 0;
  words[15] =
    (((prefix[3] | 0) << 24) | ((prefix[4] | 0) << 16) | ((prefix[5] | 0) << 8) | (prefix[6] | 0)) >>> 0;

  for (let i = 16; i < 30; i++) {
    let value = SHA256_SCHEDULE[i - 16];
    const s1 = sSigma1(words[i - 2]);
    value += i === 16 ? (s1 ^ SHA256_SIGMA1_ADJUSTMENT) : s1;
    if (i - 7 >= 14) value += words[i - 7];
    if (i - 15 >= 14) {
      const s0 = sSigma0(words[i - 15]);
      value += i === 29 ? (s0 ^ SHA256_SIGMA0_ADJUSTMENT) : s0;
    }
    words.push(value >>> 0);
  }

  words.push(
    (sSigma1(words[28]) + words[23] + sSigma0(words[15]) + words[14] +
      SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14]) >>> 0
  );
  expandSchedule(words, 31);

  const working = sha256Rounds(SHA256_STATE, words, 14);
  return working.map((x, i) => ((x + SHA256_INITIAL[i]) >>> 0));
}

export function sha256Digest(data) {
  const length = 57 + data.length;
  const padded = [];
  for (let i = 7; i < data.length; i++) padded.push(data[i]);
  padded.push(0x80);
  const padLen = (((55 - length) % 64) + 64) % 64;
  for (let i = 0; i < padLen; i++) padded.push(0);
  const bits = BigInt(length) * 8n;
  for (let i = 7; i >= 0; i--) padded.push(Number((bits >> BigInt(i * 8)) & 0xffn));

  let state = sha256Init(data.subarray(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const words = new Array(16);
    for (let i = 0; i < 16; i++) {
      const p = off + i * 4;
      words[i] = (((padded[p] | 0) << 24) | ((padded[p + 1] | 0) << 16) |
        ((padded[p + 2] | 0) << 8) | (padded[p + 3] | 0)) >>> 0;
    }
    expandSchedule(words, 16);
    const working = sha256Rounds(state, words, 0);
    state = working.map((x, i) => ((x + state[i]) >>> 0));
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (state[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (state[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (state[i] >>> 8) & 0xff;
    out[i * 4 + 3] = state[i] & 0xff;
  }
  return out;
}

export function cs64Digest(data, digest) {
  let keyA = (digest[0] | (digest[1] << 8) | (digest[2] << 16) | (digest[3] << 24)) >>> 0;
  let keyB = (digest[4] | (digest[5] << 8) | (digest[6] << 16) | (digest[7] << 24)) >>> 0;
  keyA = (keyA | 1) >>> 0;
  keyB = (keyB | 1) >>> 0;

  const factors = [imul(keyA, CS64_FACTOR), imul(keyB, CS64_FACTOR)];
  const terms = [];
  const offsets = [];
  for (let i = 0; i < CS64_COEFFICIENTS.length; i++) {
    terms.push(imul(CS64_COEFFICIENTS[i][0], factors[i % 2]));
    offsets.push(CS64_COEFFICIENTS[i][1]);
  }

  const buf = new Uint8Array(data.length + 1);
  buf.set(data, 1);
  const words = wordsLe4Even(buf);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const even = i % 2 === 0;
    let term = imul(word, even ? keyA : keyB);
    let offset = imul(rol16(word), even ? 0xef0569fb : 0xc31713db);
    if (i === 0) {
      term = (term + imul(CS64_ADJUSTMENT0, factors[0])) >>> 0;
      offset = (offset + CS64_ADJUSTMENT1) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  }

  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i];
    const y = terms[i + 1];

    let t = rol16((offsets[i] + x) >>> 0);
    let q = imul(t, 0x76f50f34);
    swapAcc = (swapAcc + ((imul(rol16(q), 0xc3efea97) + q) >>> 0)) >>> 0;

    t = rol16((offsets[i + 1] + y) >>> 0);
    q = imul(t, 0x1881ce3c);
    swapLast = (imul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (imul(state, keyA) + x) >>> 0;
    state = imul(rol16(state), 0xcf98b111);
    state = imul(rol16(state), 0x87085b9f);
    state = imul(rol16(state), 0x12ceb96d);
    state = imul(rol16(state), 0x257e1d83);
    acc = (acc + state) >>> 0;

    t = (imul(state, keyB) + y) >>> 0;
    t = imul(rol16(t), 0xa27416f5);
    t = imul(rol16(t), 0xd38396ff);
    state = imul(rol16(imul(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = (acc + state) >>> 0;
  }

  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s.toUpperCase();
}

export function generateSecMsGec(unixTimestamp) {
  const secs = Math.floor(unixTimestamp === undefined ? Date.now() / 1000 : unixTimestamp);
  let ticks = BigInt(secs) + WIN_EPOCH;
  ticks -= ticks % 300n;
  const payload = `${ticks * 10000000n}${TRUSTED_CLIENT_TOKEN}`;
  const data = new TextEncoder().encode(payload);
  const digest = sha256Digest(data);
  const [lo, hi] = cs64Digest(data, digest);
  const csBytes = new Uint8Array(8);
  for (let i = 0; i < 4; i++) {
    csBytes[i] = (lo >>> (i * 8)) & 0xff;
    csBytes[4 + i] = (hi >>> (i * 8)) & 0xff;
  }
  return `${toHex(csBytes)}-${toHex(digest)}`;
}

/* ============================================================
 *  Edge TTS 通信
 * ============================================================ */

function dateToString() {
  const d = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(
    d.getUTCHours()
  )}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

const escapeXml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * 注意：实测 speech.platform.bing.com 的 readaloud 端点已不再接受
 *       <mstts:express-as>（任何 style / role 写法都会以 close 1007 拒绝握手后断开），
 *       因此这里不把风格写进 SSML，风格参数仅做兼容性接收、不参与合成。
 */
function buildSsml({ text, voice, rate, pitch, volume }) {
  const prosody = `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${escapeXml(text)}</prosody>`;
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'>${prosody}</voice></speak>`;
}

const hex16 = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return toHex(b);
};

/* ------------------------------------------------------------
 * 发音人：朗读端点目前只保留 14 个中文声音。旧引擎里那批
 * （晓辰/晓涵/云野/各种 HD 与多语版）已经下线，直接请求会被断开，
 * 这里做一层别名兜底，保证选了也能出声。
 * ---------------------------------------------------------- */
const ZH_SUPPORTED = new Set([
  "zh-CN-XiaoxiaoNeural", "zh-CN-XiaoyiNeural", "zh-CN-YunjianNeural", "zh-CN-YunxiNeural",
  "zh-CN-YunxiaNeural", "zh-CN-YunyangNeural", "zh-CN-liaoning-XiaobeiNeural", "zh-CN-shaanxi-XiaoniNeural",
  "zh-TW-HsiaoChenNeural", "zh-TW-HsiaoYuNeural", "zh-TW-YunJheNeural",
  "zh-HK-HiuGaaiNeural", "zh-HK-HiuMaanNeural", "zh-HK-WanLungNeural",
]);

const ZH_ALIAS = {
  "zh-CN-XiaochenNeural": "zh-CN-XiaoxiaoNeural",
  "zh-CN-XiaohanNeural": "zh-CN-XiaoxiaoNeural",
  "zh-CN-XiaomengNeural": "zh-CN-XiaoxiaoNeural",
  "zh-CN-XiaomoNeural": "zh-CN-XiaoxiaoNeural",
  "zh-CN-XiaoqiuNeural": "zh-CN-XiaoxiaoNeural",
  "zh-CN-XiaorouNeural": "zh-CN-XiaoxiaoNeural",
  "zh-CN-XiaoruiNeural": "zh-CN-XiaoxiaoNeural",
  "zh-CN-XiaoshuangNeural": "zh-CN-XiaoyiNeural",
  "zh-CN-XiaoyanNeural": "zh-CN-XiaoxiaoNeural",
  "zh-CN-XiaoyouNeural": "zh-CN-XiaoyiNeural",
  "zh-CN-XiaozhenNeural": "zh-CN-XiaoxiaoNeural",
  "zh-CN-XiaoxiaoDialectsNeural": "zh-CN-XiaoxiaoNeural",
  "zh-CN-XiaoxiaoMultilingualNeural": "zh-CN-XiaoxiaoNeural",
  "zh-CN-XiaoyuMultilingualNeural": "zh-CN-XiaoyiNeural",
  "zh-CN-YunfengNeural": "zh-CN-YunxiNeural",
  "zh-CN-YunhaoNeural": "zh-CN-YunxiNeural",
  "zh-CN-YunjieNeural": "zh-CN-YunxiNeural",
  "zh-CN-YunyeNeural": "zh-CN-YunjianNeural",
  "zh-CN-YunzeNeural": "zh-CN-YunjianNeural",
  "zh-CN-YunxiaoMultilingualNeural": "zh-CN-YunxiNeural",
  "zh-CN-YunyiMultilingualNeural": "zh-CN-YunyangNeural",
  "zh-CN-YunfanMultilingualNeural": "zh-CN-YunxiNeural",
};

function normalizeVoice(input) {
  const raw = String(input || "").trim();
  if (!raw) return "zh-CN-XiaoxiaoNeural";

  // HD 系列形如 zh-CN-Xiaochen:DragonHDLatestNeural，取别名映射到普通版
  if (raw.includes(":")) {
    const base = `${raw.split(":")[0]}Neural`;
    if (ZH_SUPPORTED.has(base)) return base;
    if (ZH_ALIAS[base]) return ZH_ALIAS[base];
    return base.startsWith("zh-") ? "zh-CN-XiaoxiaoNeural" : "en-US-EmmaNeural";
  }

  if (ZH_SUPPORTED.has(raw)) return raw;
  if (ZH_ALIAS[raw]) return ZH_ALIAS[raw];
  if (raw.startsWith("zh-TW")) return "zh-TW-HsiaoChenNeural";
  if (raw.startsWith("zh-HK")) return "zh-HK-HiuMaanNeural";
  if (raw.startsWith("zh-")) return "zh-CN-XiaoxiaoNeural";

  // 其他语言原样透传，不做限制
  return raw;
}

export { dateToString, buildSsml, hex16, normalizeVoice };
export {
  TRUSTED_CLIENT_TOKEN,
  SEC_MS_GEC_VERSION,
  USER_AGENT,
  OUTPUT_FORMAT,
  WSS_BASE,
};
