# 部署到 EdgeOne Pages（Node.js 云函数版）

EdgeOne Pages 不只是静态托管。它自带的 **Pages Functions** 提供两种 Serverless：
这份代码用的是其中的 **Cloud Functions（Node.js v20 运行时）**，因为只有它支持完整的
Node 原生模块——我们需要用 `node:https` 自己做 WebSocket 握手。

| Functions 类型 | 运行时 | 能用吗 | 原因 |
|---|---|---|---|
| Edge Functions | Edge Runtime | ❌ | 受限沙箱，无法做 WebSocket 出站握手 |
| **Cloud Functions** | **Node.js v20** | ✅ | 完整 Node 能力 + npm 生态 |

> 我们的实现**没有引入任何第三方依赖**（握手、收发帧全部手写），
> 构建时不需要 `npm install`，部署最稳。

## 为什么换到 EdgeOne

对比之前那个 Cloudflare Workers 版本，核心差别在网络可达性：

| | Cloudflare Workers | EdgeOne Pages |
|---|---|---|
| 国内能否直连 | ⚠️ `*.workers.dev` 常被 DNS 污染 | ✅ 腾讯自己的域名和节点，解析正常 |
| 需要自己的域名 | **必须**（绑境外的免费域名） | 不需要，平台直接给 `xxx.edgeone.app` |
| HTTPS 证书 | 自动签发 | 自动签发 |
| 免费额度 | 10 万请求/天 | **约 100 万 Cloud Functions 请求/月，流量不限** |
| 需要备案 | 不需要 | 不需要（但受下面「加速区域」限制） |

## 目录结构

```
edgeone-pages/
├── cloud-functions/          # ← Node.js 云函数（文件即路由）
│   ├── index.js              #   路由 /
│   └── api/
│       ├── tts.js            #   路由 /api/tts    合成音频
│       ├── debug.js          #   路由 /api/debug  自检（返回 JSON）
│       └── health.js         #   路由 /api/health 健康检查
├── lib/                      # 非入口文件，会被一并打包
│   ├── edge-drm.js           #   Sec-MS-GEC v2 签名（从 Cloudflare 版原样抽来）
│   └── synth.js              #   WebSocket 握手 / 收发帧 / 分块合成
├── public/index.html         # 静态说明页
├── package.json              # type: module，无依赖
└── local-test.mjs            # 本地验收脚本
```

## 部署步骤

### 1. 推到 Git 仓库

把整个 `edgeone-pages` 目录推到一个 GitHub 仓库（EdgeOne Pages 靠 Git 触发构建）。

### 2. 控制台创建项目

1. 打开 https://console.cloud.tencent.com/edgeone/pages
2. **创建项目 → 导入 Git 仓库**，选中刚那个仓库
   （不想用 Git 也可以本地 `npm i -g edgeone` 后用 `edgeone` CLI 上传）
3. 构建配置：
   - 框架预设：**Other**
   - 构建命令：**留空**（这份代码没有构建步骤）
   - 输出目录：**`public`**
   - 安装命令：留空

### 3. 加速区域（这一步最容易踩坑）

平台会让你选「加速区域」，它直接决定能不能用中国大陆节点：

- **没有已备案的域名** → 只能选 **「全球可用区（不含中国大陆）」**
  节点落在新加坡/中国香港等地，但**域名解析正常、不会被污染**，国内可以正常访问，延迟稍高
- **有已备案域名** → 选 **「全球可用区（含中国大陆）」**，并绑自己的域名，
  延迟一下子降到 20~50ms

⚠️ 这不是 bug，是政策要求：中国大陆节点的 CDN 域名必须完成 ICP 备案。
选「不含中国大陆」不影响可用性，只是请求要出海绕一圈。

### 4. 调高单次执行时间

默认单次请求最长 **30 秒**。合成一段 800 字文本约 15 秒，长文可能超时被截断。
建议进 **项目设置 → 函数管理 → 执行超时**，改到 **60 秒**（上限 120 秒）。

代码里 `lib/synth.js` 的 `TOTAL_BUDGET_MS` 目前是 24 秒，改完平台超时后
可以同步把它调到 45 秒左右。

### 5. 验证

部署完平台会分配一个 `xxx.edgeone.app` 域名，浏览器打开：

```
https://xxx.edgeone.app/api/debug?t=你好，这是自检
```

看到 `headHex = "fff364"`、`bytes > 0` 就是**真的出声了**。
`fff364` 是标准 MP3 帧头，这个值能排除「返回了空音频」的伪装情况。

### 6. 填进阅读 App

朗读引擎地址填：

```
https://xxx.edgeone.app/api/tts
```

配套的 `legado-engine.js` 里已经加了这个选项，部署完替换一下域名、
在引擎设置的「接口」里切过去即可。

## 可选：加口令防盗用

虽然流量免费，**月配额 100 万次**也不是无限的。建议加个口令：

1. EdgeOne Pages 控制台 → 项目设置 → **环境变量**，加一条 `TTS_TOKEN`，值随意
2. 请求时带上：`/api/tts?t=你好&token=你的口令`
3. 阅读 App 那边把地址写成 `https://xxx.edgeone.app/api/tts?token=你的口令`

## 自检 / 排错

本地先跑一遍，确认代码本身没问题：

```bash
npm test        # 等价于 node local-test.mjs
```

会依次验证：短句、语速参数、已下线发音人兜底、粤语、英文、800 字长文分块。

线上排查看这里：

| 现象 | 原因 |
|---|---|
| `/api/debug` 返回 `bytes: 0`、`reason: "error"` | 多半是握手被拒（403），说明微软又改了签名算法，需要更新 `edge-drm.js` |
| 返回 HTTP 502 | 合成没拿到音频，看云函数日志里的 `reasons` |
| 长文本被截断 | 超过预算时间，调高「执行超时」和 `TOTAL_BUDGET_MS` |
| 某个发音人没声音 | 服务端已下线的声音已做别名兜底（见 `edge-drm.js` 的 `ZH_ALIAS`） |

## 已知限制

- Edge 朗读端点**不支持 `<mstts:express-as>` 风格标签**（任何写法都会被 1007 断开），
  所以 `s` 风格参数只接收不使用。这也是为什么引擎脚本里没有风格选项。
- 单次请求文本上限 `MAX_TEXT_LENGTH = 1200` 字，更长的会被截断；
  阅读 App 本身是分段请求的，实际很少触发。
- 请求/响应体上限 6 MB，够用。
