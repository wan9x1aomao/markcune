# 一键整理的网关

应用不持有模型名、Key 或提示词，整理时只把**原始行**发到这里，拿回**每行的标签**。
文字始终由应用自己从原始行拼出来，所以这个服务改不了、也丢不了用户的原话。

接口约定见 [`docs/tidy-gateway.md`](../docs/tidy-gateway.md)。这里是它的一个实现。

```
应用 ──POST {lines:[…]}──▶ 网关 ──▶ 模型（只回标签）
     ◀──{labels:[…]}────
```

## 怎么跑

```bash
TIDY_API_KEY=sk-xxxx node gateway/tidy-gateway.mjs
```

零依赖，Node 18+ 即可（用的是内置 `fetch`）。默认监听 `8787`。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TIDY_API_KEY` | 空 | 上游 Key。**没配置时整理请求一律返回 503**，应用会退回规则整理 |
| `TIDY_BASE_URL` | `https://api.deepseek.com/v1` | 任何 OpenAI 兼容接口 |
| `TIDY_MODEL` | `deepseek-chat` | 模型名 |
| `PORT` | `8787` | 监听端口 |
| `TIDY_TOKEN` | 空 | 设了之后要求 `Authorization: Bearer <token>` |
| `TIDY_JSON_MODE` | `1` | 要求上游返回 JSON；个别上游不支持时设 `0` |
| `TIDY_MAX_TOKENS` | `4096` | 一次生成的上限 |
| `TIDY_TIMEOUT_MS` | `45000` | 调上游的超时（应用那边是 60 秒） |

自检：`curl http://127.0.0.1:8787/health` → `{"ok":true,"ready":true,…}`

## 接到应用

**调试**：应用允许明文的本机地址，直接给环境变量即可，不用重新打包：

```bash
MDPAD_TIDY_URL=http://127.0.0.1:8787/tidy open /Applications/MDPad.app
```

**发布**：地址需要在打包时固定进去（`src-tauri/src/ai.rs` 读的是构建期常量）。
填 [scripts/release.conf](../scripts/release.conf) 里的 `TIDY_URL` 一处，
macOS 本机打包和 GitHub Actions 上的 Windows / Linux 都会带上——三个平台共用同一个来源。

```conf
TIDY_URL="https://你的网关/tidy"
```

留空就是纯规则整理，功能照常可用，只是不会调用模型。

## 本地联调（没有模型 Key 也能验）

用一个模型桩顶替上游，整条链路照样能跑通，不花一分钱、不碰真模型：

```bash
node tests/mock-model.mjs &                                     # 桩，默认 8792
TIDY_API_KEY=x TIDY_BASE_URL=http://127.0.0.1:8792/v1 \
  TIDY_MODEL=mock-model PORT=8793 node gateway/tidy-gateway.mjs &  # 网关，8793

# 打开应用让它走这条链路（调试期用环境变量即可，不必重新打包）
MDPAD_TIDY_URL=http://127.0.0.1:8793/tidy <MDPad 可执行文件> 某个没排版的.md
```

整理完提示会写「已AI 整理」，文件里会出现 `###` 这类**规则不可能产生**的标记——这才是模型真的生效过的证据
（只看「有标记了」不算，规则自己也会加标记）。

> **本机设了 `HTTP_PROXY` 时要注意**：reqwest 默认会走它，请求会发给代理而不是网关，
> 表现为「连不上整理服务」或莫名其妙的 502，而网关那边一条日志都没有。
> 调试时把代理变量去掉：`env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy ...`，
> 或把网关主机加进 `NO_PROXY`。

## 失败时会怎样

| 情况 | 返回 | 应用的表现 |
|---|---|---|
| 模型给出等长的合法标签 | `200 {labels}` | 用模型的标签整理 |
| 模型给出的标签数量不对 | 再问一次；仍不对则 `502` | 这一段退回规则整理，提示里带上网关给的原因 |
| 上游报错/超时/连不上 | `502` | 同上 |
| 没有配 `TIDY_API_KEY` | `503` | 同上 |
| 请求超过 400 行或 3 万字 | `413` | 应用本来就会分块，正常不会撞上 |

网关**不会**假装成功：模型不可用时如实返回错误，应用自己会用规则兜底。
否则提示里会写着「AI 整理」，实际却是规则做的。

空行/非空行的标签会被网关按行强制纠正（空行必定是 `blank`，有字的行必定不是）。
这两个事实从行本身就能看出来，纠正它们不可能改动任何文字，但能挡掉模型最常见的一类手滑。

## 放在哪里

这个服务只有一个文件（外加 `../src/tidy.js`），任何能跑 Node 的地方都行：

- **本机**：自己用，或用来调试这条链路。地址用 `http://127.0.0.1:PORT/tidy`。
- **内网服务器**：给一个团队或一家客户用。应用不发 Key，鉴权放在网络层（内网、IP 白名单、mTLS）。
- **公网**：要做成对外发布的软件才需要。这时**必须**加鉴权——否则任何人拿到地址就能刷你的模型额度。
  至少设一个 `TIDY_TOKEN`，并且在前面套一层限流。

> 注意：把地址写进正式包之后不要再改域名，否则已装的应用会永久失去这个功能；
> 这和更新地址的约束是同一个道理。

## 测试

```bash
node tests/gateway.test.mjs
```

不连外网：用一个模型桩替换上游，覆盖正常、标签数量不符、上游故障、无 Key、令牌、
上游不支持 `response_format`，以及「网关给出的标签必须能过应用自己的校验」。
