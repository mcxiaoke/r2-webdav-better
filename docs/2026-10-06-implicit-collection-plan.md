# 让 WebDAV 识别 R2 隐式目录 —— 分析与实施方案

- 文档创建时间：2026-10-06 17:49:11
- 适用版本：本 fork（HEAD `6dae776`），上游基线 `abersheeran/r2-webdav@4680a23` 之后
- 规范依据：RFC 4918（WebDAV）。原文已下载至 `.temp/rfc4918.txt`，下文引用均按行号可复核
- 状态：**已实施完成**（S0-S7 全部完成）。实施摘要、验证结果与两处与本文档的偏差见 `docs/CHANGES-20261006.md`

---

## 1. 现象与复现

### 1.1 现象

直接从 R2 侧（控制台、`wrangler r2 object put`、S3 API、rclone 的 S3 后端）写入对象后，WebDAV 客户端看不到这些对象的父目录：

- 根目录列表里没有该目录
- 直接访问 `PROPFIND /<dir>/` 返回 404
- 但按完整路径访问文件本身是正常的

### 1.2 实测证据（本地 `wrangler dev` + 本地 R2 持久化）

测试环境：`wrangler r2 object put --local` 直写本地桶，`wrangler dev --port 8788` 提供 WebDAV。

| R2 里的 key       | `PROPFIND /` Depth:1 | `PROPFIND /<父目录>/`              | 直接访问文件                      | 说明                             |
| ----------------- | -------------------- | ---------------------------------- | --------------------------------- | -------------------------------- |
| `root-file.txt`   | 出现                 | —                                  | GET 200 / PROPFIND 207            | key 不含 `/`，等同根级文件，正常 |
| `photos/deep.txt` | **不出现**           | `/photos/` → **404**               | GET 200 / HEAD 200 / PROPFIND 207 | 数据在，目录层不存在             |
| `a/b/c/deep.txt`  | **不出现**           | `/a/`、`/a/b/`、`/a/b/c/` 全部 404 | 可读                              | 中间层级全部缺失                 |

补充实测（同一环境）：

| 操作                                           | 结果                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `MKCOL /photos/`（补建目录标记对象）           | 201，随后 `/photos/` 与 `/photos/deep.txt` **立刻同时**出现在列表里      |
| `PUT /a/b/c/new.txt`（父目录无标记但已有后代） | **201 成功** — 说明写路径已被上游 PR #27 放开                            |
| `PUT /nodir/x.txt`（父目录完全不存在）         | 409 Conflict — 正确                                                      |
| `DELETE /photos/`（无标记目录）                | **404**（`src/index.ts:1099-1102` 先 `head()`，取不到即返回 404）        |
| `PROPFIND /` Depth:infinity                    | 只列出叶子文件 `a/b/c/deep.txt`，中间目录 `a`、`a/b`、`a/b/c` 一个都没有 |

### 1.3 代码定位

| 位置                                                       | 行为                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts:22-41` `listAll()`                           | 只 `yield r2_objects.objects`，**完全丢弃 `delimitedPrefixes`**。全仓库搜索 `delimitedPrefixes` / `commonPrefixes` 零匹配 |
| `src/index.ts:158-173` `hasCollectionResource()`           | 先 `head()` 看 `resourcetype === '<collection />'`，取不到再 `list({prefix: path + '/', limit:1})` 兜底 → **写放开了**    |
| `src/index.ts:1129-1156` `handle_mkcol()`                  | 目录 = 一个 key 为目录名（**无尾斜杠**）、`customMetadata = { resourcetype: '<collection />' }` 的空对象                  |
| `src/index.ts:924-928` `handle_get()` 目录分支             | `head()` 为 null 或缺标记 → 404                                                                                           |
| `src/index.ts:1237-1242` / `1244-1250` `handle_propfind()` | Depth:1 用非递归 list，Depth:infinity 用递归 list，两者都只遍历 `listAll()` 产出的对象                                    |
| `src/index.ts:789` `fromR2Object()`                        | `displayname` 取 `httpMetadata.contentDisposition`（下文 §5.7）                                                           |

### 1.4 上游态度（不是疏漏，是明确决策）

- Issue **#16 "Don't see any files"**：作者回复 "Please try use WebDav API to upload file."
- Issue **#17 "Can't open subfolders in transmit or cyberduck and I don't see them in the browser"**：作者回复 **"Please use r2-webdav api to create dir. Do not operate R2 directly."**，并声明 "I only consider this project for my personal use, so it does not support any other functions besides my needs."
- 但 PR **#27 `fix(webdav): allow writes in implicit collections`（已 merge）** 部分让步，改动只有两处：
  ```diff
  -	return resource?.customMetadata?.resourcetype === '<collection />';
  +	if (resource !== null) {
  +		return resource.customMetadata?.resourcetype === '<collection />';
  +	}
  +	let descendants = await bucket.list({ prefix: resourcePath + '/', limit: 1 });
  +	return descendants.objects.length > 0;
  ```
  **只放开了"往隐式目录里写"，没有放开"列出隐式目录"**，形成"能写进去、看不到、进不去"的半吊子状态。

---

## 2. 规范判定：当前行为违反 RFC 4918

### 2.1 违反条款

**§5.2 Collection Resources**（`.temp/rfc4918.txt:848-853`）：

> For all WebDAV-compliant resources A and B, identified by URLs "U" and "V", respectively, such that "V" is equal to "U/SEGMENT", **A MUST be a collection that contains a mapping from "SEGMENT" to B.**

实测 `PROPFIND /photos/deep.txt` 返回 **207**，证明该资源是 WebDAV-compliant。于是 `/photos/` **MUST** 是集合。当前返回 404，直接违反。

**§9.1 PROPFIND Method**（`.temp/rfc4918.txt:2007-2010`）：

> Consequently, the 'multistatus' XML element for a collection resource **MUST include a 'response' XML element for each member URL of the collection**, to whatever depth was requested.

`PROPFIND /` Depth:1 漏掉 `/photos/`，同样违反。

### 2.2 唯一可能的豁免条款不成立

**§5.2**（`.temp/rfc4918.txt:871-880`）：

> Collection resources MAY have mappings to **non-WebDAV-compliant** resources in the HTTP URL namespace hierarchy but are not required to do so.  
> If a WebDAV-compliant resource has no WebDAV-compliant internal members in the HTTP URL namespace hierarchy, then the WebDAV-compliant resource is not required to be a collection.

豁免前提是成员"非 WebDAV 兼容"。本项目对任意存在的对象都响应 PROPFIND，成员全部兼容，**豁免不成立**。

### 2.3 结论

改造是**回归规范**，不是偏离规范。上游对该问题的回避是产品取舍，不是规范允许。

---

## 3. 目标与非目标

### 3.1 目标

1. R2 中以 key 前缀形式存在、但没有标记对象的目录，能在 PROPFIND 与目录 GET 中列出
2. 这类"隐式目录"能被进入、能按集合语义删除
3. 保持与现有 MKCOL 目录完全一致的客户端表现
4. 不违反 RFC 4918 的 MUST 条款，包括"一个 path segment 只能映射一个资源"
5. 不增加 R2 调用次数（净开销应持平或下降）

### 3.2 非目标

- 不改动写路径语义（`hasCollectionResource` 的隐式目录写支持已由 PR #27 提供，沿用）
- 不引入"自动建目录"行为（PUT 到不存在的父目录仍返回 409，符合 §9.7.1）
- 不实现 `Depth: infinity` 的服务端展开优化（保持现状：递归 list）
- 不改变锁（LOCK/UNLOCK）的存储模型
- 不修复 `handle_put` 的 `request.arrayBuffer()` 全量缓冲（独立议题，另开）

---

## 4. 数据模型：目录在 R2 里的两种存在形式

| 形式         | 存储表现                                                                         | 产生方式     | 当前可见性                |
| ------------ | -------------------------------------------------------------------------------- | ------------ | ------------------------- |
| **显式目录** | key = 目录名（无尾斜杠），值空，`customMetadata.resourcetype = '<collection />'` | 本项目 MKCOL | 可见                      |
| **隐式目录** | 没有任何对象，仅作为其他 key 的前缀存在（`photos/`）                             | 直写 R2      | **不可见** ← 本方案要解决 |
| 空目录       | 只有显式目录这一种形式（R2 无目录概念）                                          | MKCOL        | 可见，保持不变            |

关键点：**同名目录可能同时以两种形式存在**（例如先直写 `photos/a.jpg`，再 MKCOL `photos/`）。`bucket.list` 会同时返回对象 `photos` 与前缀 `photos/`，二者必须合并为一个条目。

---

## 5. 详细设计

### 5.1 新增 `listMembers()`，**不要改 `listAll()`**

`listAll()` 现有 6 处调用，语义各不相同：

| 调用点 | 用途                                           | 能否接受合成目录                    |
| ------ | ---------------------------------------------- | ----------------------------------- |
| `880`  | `assertRecursiveDeletePermission()` 锁递归检查 | **不能**（会访问 `customMetadata`） |
| `939`  | `handle_get()` 目录 HTML 列表                  | 能                                  |
| `1239` | `handle_propfind()` Depth:1                    | 能                                  |
| `1247` | `handle_propfind()` Depth:infinity             | 能（但要区分层级）                  |
| `1422` | `handle_copy()` 递归                           | **不能**                            |
| `1552` | `handle_move()` 递归                           | **不能**                            |

因此新增一个独立函数，只在 `939` / `1239` 使用：

```ts
type DavMember = { kind: 'object'; object: R2Object } | { kind: 'collection'; key: string }; // key 无尾斜杠

async function* listMembers(bucket: R2Bucket, prefix: string): AsyncGenerator<DavMember> {
	let cursor: string | undefined = undefined;
	const seen = new Set<string>();
	do {
		const page = await bucket.list({
			prefix,
			delimiter: '/',
			cursor,
			// @ts-ignore 与 listAll() 保持一致：不 include 就拿不到 customMetadata，
			// 显式目录会被误判成普通文件，去重逻辑随之失效
			include: ['httpMetadata', 'customMetadata'],
		});
		for (const object of page.objects) {
			// 显式目录：key 即目录名（MKCOL 写入，无尾斜杠）
			if (object.customMetadata?.resourcetype === '<collection />') {
				if (seen.has(object.key)) continue;
				seen.add(object.key);
				yield { kind: 'collection', key: object.key };
				continue;
			}
			yield { kind: 'object', object };
		}
		for (const delimited of page.delimitedPrefixes) {
			// delimitedPrefix 形如 "photos/"；去掉尾斜杠得到 path segment
			const key = delimited.endsWith('/') ? delimited.slice(0, -1) : delimited;
			if (seen.has(key)) continue; // 去重：显式目录优先
			seen.add(key);
			yield { kind: 'collection', key };
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor !== undefined);
}
```

要点：

1. **`include` 必须带上** `customMetadata`，否则 `page.objects` 里的显式目录不带 metadata，会被当成普通文件输出，去重逻辑同时失效（`listAll()` 已有同样的 `@ts-ignore` 处理，见 `src/index.ts:29-31`）
2. **分页**：`objects` 与 `delimitedPrefixes` 共享单页 1000 条的上限，**每页都要同时收集两者**，不能只按 `objects` 判断是否结束
3. **去重**：以去掉尾斜杠后的 key 为唯一键，显式目录先入 `seen`，`delimitedPrefixes` 命中即跳过 —— 满足 §5.2 的 "at most one mapping for a given path segment"
4. **`listAll()` 保持原样**，零回归风险

### 5.2 `handle_propfind()` 改动

- `resource_path === ''`（根）：`is_collection` 已为 true，无需改动
- 非根路径：`is_collection` 的计算从
  ```ts
  is_collection = object.customMetadata?.resourcetype === '<collection />';
  ```
  改为
  ```ts
  is_collection = await hasCollectionResource(bucket, resource_path);
  ```
  但要注意 `bucket.head()` 返回 null 时**不能直接 404**：只有 `hasCollectionResource()` 也为 false 才 404。即：
  ```ts
  let object = await bucket.head(resource_path);
  if (object === null) {
  	if (!(await hasCollectionResource(bucket, resource_path))) {
  		return new Response('Not Found', { status: 404 });
  	}
  	is_collection = true;
  } else {
  	is_collection = object.customMetadata?.resourcetype === '<collection />';
  }
  page += generate_propfind_response(object, propfindRequest, resource_path);
  ```
- Depth:1 分支把 `listAll(bucket, prefix)` 换成 `listMembers(bucket, prefix)`
- Depth:infinity 分支**保持 `listAll(..., true)` 不变**（递归展开时客户端会逐层 PROPFIND，且合成目录节点没有 `customMetadata`，混入递归路径容易出问题）。可选项：递归时对遇到的中间层级补合成目录节点 —— **建议 v1 不做**，先保证 Depth:1 正确

### 5.3 `generate_propfind_response()` 支持合成目录节点

现状签名 `generate_propfind_response(object: R2Object | null, propfindRequest)`，`null` 仅用于根。

改造为接受 `R2Object | { syntheticCollectionKey: string } | null`，对合成目录：

- `href` = `getResourceHref(key, true)`（复用现有逻辑，产出 `/photos/`）
- `resourcetype` = `<collection />` —— **RFC 4918 §15.9**（`.temp/rfc4918.txt:5343-5344`）："**MUST** be defined on all DAV-compliant resources." 必须输出
- `creationdate` → 返回 404 propstat —— **§15.1**（`.temp/rfc4918.txt:5049-5051`）："Servers that are incapable of persistently recording the creation date SHOULD instead leave it undefined (i.e. report 'Not Found')." 规范明确允许
- `getlastmodified` → 返回 404 propstat —— **§15.7**（`.temp/rfc4918.txt:5230-5232`）："The DAV:getlastmodified property **MUST** be defined on any DAV-compliant resource **that returns the Last-Modified header in response to a GET**." 合成目录的目录 GET 当前**不返回** `Last-Modified`，因此该 MUST 不触发
  - ⚠️ **耦合约束**：如果将来给目录 GET 加上 `Last-Modified` 头，就必须同时为合成目录实现 `getlastmodified`（例如取子项 `uploaded` 的最大值，需额外一次 list）
- `getcontentlength` / `getetag` / `getcontenttype` / `displayname` → 404 propstat
- `supportedlock` / `lockdiscovery` / `getcontentlanguage` → 沿用目录的现有处理方式（与显式目录保持一致，避免同类资源两种表现）

### 5.4 `handle_get()` 目录分支

`src/index.ts:924-928` 的判空逻辑同样放宽：

```ts
if (resource_path !== '') {
	if (!(await hasCollectionResource(bucket, resource_path))) {
		return new Response('Not Found', { status: 404 });
	}
}
```

HTML 列表的循环（`939`）改用 `listMembers()`，合成目录渲染成带 `/` 的链接。

### 5.5 `handle_delete()` 对齐

`src/index.ts:1099-1102`：

```ts
let resource = await bucket.head(resource_path);
if (resource === null) {
	return new Response('Not Found', { status: 404 });
}
```

改为：`head()` 为 null 时再 `hasCollectionResource()` 判定，成立则走集合删除分支（即跳到 `1108-1123` 的前缀递归删除，跳过 `1125` 那次对不存在对象的 `delete` 调用）。**不做这一步会出现"列表里看得见但删不掉"**。

### 5.6 `handle_lock()` 的既有副作用（需记录，非本方案修复）

`src/index.ts:1630`：对不存在的资源加锁时会 `bucket.put(resource_path, new Uint8Array(), ...)` 造占位对象。也就是说**给隐式目录加一次 LOCK 会把它永久变成显式目录**。这是既有行为，改造后仍然成立，属于"可接受但需知晓"。文档记录，不在本方案改动。

### 5.7 顺带修复：`displayname` 取值错误

`src/index.ts:789`：

```ts
displayname: object.httpMetadata?.contentDisposition,
```

R2 控制台上传常带 `Content-Disposition: attachment; filename="x.txt"`，客户端列表会显示成整串 header 值。建议改为：优先取 `contentDisposition` 中的 `filename=`，否则回退到 **key 的最后一段**。

- 依据 **§15.2**：`displayname` 是 SHOULD 级属性，服务端可自行决定取值
- 与本方案耦合度高（处理直写对象时必然暴露），建议同批提交

### 5.8 COPY / MOVE 的处理

`handle_copy` / `handle_move` 的递归逻辑（`1422` / `1552`）**不改**（仍用 `listAll(..., true)`）。但需确认：

- 对隐式目录做 `MOVE`/`COPY` 时，源集合的 `head()` 为 null 会怎样 —— 若返回 404 则与"列表可见"不一致，需实测；如不一致，用与 §5.5 相同的放宽方式处理
- 验收清单（§7.3）包含这条

---

## 6. 影响面与风险

| #   | 风险                                            | 严重度 | 处置                                                                                                                                                  |
| --- | ----------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 目录重复出现（显式目录 + 同名 delimitedPrefix） | 高     | `listMembers()` 内按去掉尾斜杠的 key 去重，显式优先                                                                                                   |
| 2   | 污染 `listAll()` 破坏 LOCK / COPY / MOVE 递归   | 高     | 不动 `listAll()`，新增独立函数                                                                                                                        |
| 3   | 分页丢前缀（>1000 条目录）                      | 中     | 每页同时收集 `objects` 与 `delimitedPrefixes`                                                                                                         |
| 4   | 合成目录缺 live property 导致严格客户端异常     | 中     | 按 §5.3 逐一处理；`resourcetype` 必须有，`creationdate`/`getlastmodified` 报 404 有规范依据                                                           |
| 5   | 能列出但进不去 / 删不掉                         | 中     | 同步改 `handle_get`（§5.4）与 `handle_delete`（§5.5）                                                                                                 |
| 6   | MOVE/COPY 与可见性不一致                        | 中     | 实测后按需对齐（§5.8）                                                                                                                                |
| 7   | 对既有客户端造成行为变化                        | 低     | 只会"多看见"目录，丢失类风险为零                                                                                                                      |
| 8   | 性能退化                                        | 低     | 理论净改善：`delimitedPrefixes` 与 `objects` 同一次 list 返回，**零额外 R2 调用**；且 `hasCollectionResource` 的 `list({limit:1})` 探测在部分路径可省 |
| 9   | 大目录 Depth:1 响应体积增长                     | 低     | 目录数远小于文件数，且原本递归时更差                                                                                                                  |

---

## 7. 验证方案

### 7.1 环境：Windows 侧跑 wrangler，WSL 侧跑 litmus

已确认的现状：

- WSL 内 litmus 已安装：`/usr/bin/litmus`，版本 **0.13**
- WSL 访问宿主机的网关 IP：`172.23.96.1`（`ip route show default`），与 `wrangler.toml` 注释一致
- `wrangler.toml` 已配置 `[dev] ip = "0.0.0.0"`，宿主机监听所有网卡，WSL 可直连
- WSL 与 Windows 共用项目目录，litmus 在 WSL 内跑、wrangler 在 Windows 内跑，互不干扰

**动态取宿主 IP（不要硬编码，重启会变）：**

```bash
wsl -e bash -lc "ip route show default | awk '{print \$3}'"
```

### 7.2 完整 litmus 测试

litmus 的 `$TESTS` **默认值是全部 5 个套件** `basic copymove props locks http`（`litmus -h` 输出）。但 CI（`.github/workflows/litmus.yml:64`）只跑 4 个：

```yaml
TESTS: basic copymove props locks
```

原因见 README：「The `http` suite is currently excluded because local Workers runs still time out on the interim `Expect: 100-continue` response check.」

**本次要用完整 5 个套件**，因为改造集中在列举与属性语义，`props` 是重灾区，`http` 用来确认没有引入新的协议层回归（若 `http` 因 `100-continue` 已知原因失败，逐条比对是否与改动前一致，不能"新失败"）。

CI 的做法（`.github/workflows/litmus.yml`）可搬到本地：

1. `.dev.vars` 写成测试凭据（CI 用 `test` / `test`）
2. 启动 `wrangler dev`
3. 轮询直到带凭据的 `GET /` 成功
4. `TESTS="$TESTS" litmus -k "http://<HOST>:$PORT/" test test`（`-k` = keep going，跑完所有套件再汇总）

注意：wrangler v4 默认即本地模式，**不再需要 `--local`**（4.15.2 的 `wrangler dev --help` 里只有 `--local-protocol` / `--local-upstream`，没有 `--local`）。CI 里的 `--local` 是沿用的历史写法。

**建议落地的脚本**（实施时新增为 `tests/run-litmus-local.sh`）：

```bash
#!/usr/bin/env bash
# 在 Windows 侧启动 wrangler dev，再在 WSL 侧跑完整 litmus
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8787}"
TESTS="${TESTS:-basic copymove props locks http}"   # 完整 5 套件
USER="${TEST_USERNAME:-test}"
PASS="${TEST_PASSWORD:-test}"

# 1) 备份 .dev.vars（未被 git 跟踪，属"未提交文件"，必须先备份）
BACKUP=".temp/backups/.dev.vars.$(date +%Y%m%d-%H%M%S).bak"
mkdir -p .temp/backups
[[ -f .dev.vars ]] && cp .dev.vars "$BACKUP"
restore() {
	[[ -f "$BACKUP" ]] && cp "$BACKUP" .dev.vars
	[[ -n "${WRANGLER_PID:-}" ]] && kill "$WRANGLER_PID" 2>/dev/null
}
trap restore EXIT
printf 'USERNAME=%s\nPASSWORD=%s\n' "$USER" "$PASS" > .dev.vars

# 2) 启动 dev server（wrangler.toml 已设 [dev] ip = "0.0.0.0"）
npx wrangler dev --port "$PORT" > .temp/litmus-wrangler.log 2>&1 &
WRANGLER_PID=$!

# 3) 等待就绪
for i in $(seq 1 60); do
	curl -fsS -u "$USER:$PASS" "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
	sleep 1
done

# 4) 取 WSL 侧可达的宿主 IP，跑 litmus
HOST_IP="$(wsl -e bash -lc "ip route show default | awk '{print \$3}'" | tr -d '\r')"
echo "litmus target: http://${HOST_IP}:${PORT}/  tests=${TESTS}"
wsl -e bash -lc "TESTS='${TESTS}' litmus -k 'http://${HOST_IP}:${PORT}/' '${USER}' '${PASS}'"
```

排错要点：

- WSL 连不上宿主机 → 先确认 `curl -sS "http://172.23.96.1:8787/"` 在 WSL 内是否通；不通大概率是 Windows 防火墙拦了 8787 入站，需放行或改用 `netsh interface portproxy`
- `--var USERNAME:test --var PASSWORD:test` 也可注入凭据（`wrangler dev --help` 确认支持），但优先级不如 `.dev.vars` 直观，脚本里仍以改写 `.dev.vars` + 备份还原为准

### 7.3 回归测试：litmus **覆盖不到**这次改动

**重要**：litmus 只在**它自己通过 MKCOL 创建的集合**上做断言，不会构造"只有 key 前缀、没有标记对象"的目录。因此**即使全部 5 个套件通过，也不能证明隐式目录可用**。必须另加针对性用例。

**建议新增 `tests/implicit-collections.sh`**，断言清单：

| #   | 构造                                       | 断言                                                                        |
| --- | ------------------------------------------ | --------------------------------------------------------------------------- |
| 1   | 直写 `_t/root.txt`（根级）                 | `PROPFIND /` Depth:1 含 `/_t/root.txt`                                      |
| 2   | 直写 `_t/photos/deep.txt`                  | `PROPFIND /_t/` Depth:1 **含 `/_t/photos/`**（本次修复核心）                |
| 3   | 同上                                       | `PROPFIND /_t/photos/` Depth:1 返回 207 且含 `deep.txt`                     |
| 4   | 同上                                       | `GET /_t/photos/` 返回 200（HTML 列表含 `deep.txt`）                        |
| 5   | 同上                                       | 层级 `_t/a/b/c/deep.txt`：`/_t/a/` Depth:1 含 `/_t/a/b/`                    |
| 6   | 先直写 `_t/mix/x.txt`，再 `MKCOL /_t/mix/` | `PROPFIND /_t/` Depth:1 中 `_t/mix/` **只出现一次**（去重）                 |
| 7   | `MKCOL /_t/empty/`（空目录）               | `PROPFIND /_t/` Depth:1 含 `/_t/empty/`（显式目录不回归）                   |
| 8   | `DELETE /_t/photos/`                       | 204，且其后 `PROPFIND /_t/photos/` 为 404、`GET /_t/photos/deep.txt` 为 404 |
| 9   | 隐式目录 `MOVE`/`COPY`                     | 行为与显式目录一致（依 §5.8 结论定断言）                                    |
| 10  | 全部用例                                   | `PROPFIND /` Depth:1 中同一 href **不重复出现**                             |

用例 6 与用例 10 直接对应 RFC 4918 §5.2 的 "at most one mapping for a given path segment"。

### 7.4 手工验收（真实客户端）

litmus 通过后，用真实客户端确认表现（直写对象前先跑一遍做对照）：

- WinSCP（Windows）—— 用户已在用，作为主验收工具
- rclone：`rclone lsf dav:` / `rclone copy` 往返（rclone 是本机已装工具）
- wget：按完整 URL 直取文件（验证"数据一直在"）
- 浏览器：`GET /` 的 HTML 列表

---

## 8. 分步实施计划

每步独立可验证，任一步出问题可单独回滚。

| 步     | 内容                                                        | 验证                                        |
| ------ | ----------------------------------------------------------- | ------------------------------------------- |
| **S0** | 基线：跑一次**完整 5 套件** litmus，记录结果作为对照        | 全部套件结果存档（含 `http` 的既有失败项）  |
| **S1** | 新增 `listMembers()`；`displayname` 修正（§5.7）            | `listMembers` 不接入任何调用方，行为零变化  |
| **S2** | `generate_propfind_response()` 支持合成目录节点（§5.3）     | 仍无调用方产出合成节点，零变化              |
| **S3** | `handle_propfind()` 接入 `listMembers()` + 放宽 404（§5.2） | 回归测试用例 1-7、10；跑完整 litmus 比对 S0 |
| **S4** | `handle_get()` 目录分支接入（§5.4）                         | 用例 4；真实客户端验收                      |
| **S5** | `handle_delete()` 放宽（§5.5）                              | 用例 8                                      |
| **S6** | `handle_copy` / `handle_move` 实测与对齐（§5.8）            | 用例 9                                      |
| **S7** | 完整 litmus + 回归脚本 + 真实客户端三件齐备                 | 全绿（`http` 与 S0 一致）                   |

约定：

- 每步完成后按项目规则在 `docs/CHANGES-YYYYMMDD.md` 顶部追加时间戳摘要
- 每步完成后跑 Prettier（`npm run format:check`）
- 改动前对未提交文件先备份到 `.temp/backups/`

---

## 9. 回滚方案

- 全部改动集中在 `src/index.ts`，且以新增函数 + 局部替换为主
- 回滚 = `git revert` 对应提交，或把 `handle_propfind` / `handle_get` / `handle_delete` 的判定改回 `head()` 原样
- **数据无迁移**：本方案不写入任何新的 metadata 格式，隐式目录是"读时识别"，不改动 R2 里的既有对象，回滚无数据遗留

---

## 10. 附：规范条文出处

| 引用                                                         | 文件行号（`.temp/rfc4918.txt`） |
| ------------------------------------------------------------ | ------------------------------- |
| §5.2 A MUST be a collection（U/SEGMENT）                     | 848-853                         |
| §5.2 at most one mapping per path segment                    | 831-834                         |
| §5.2 non-WebDAV-compliant 豁免                               | 871-880                         |
| §9.1 Depth 0/1/infinity 要求                                 | 1950-1956                       |
| §9.1 multistatus MUST include response per member URL        | 2007-2010                       |
| §15.1 creationdate（无法持久记录则报 Not Found）             | 5049-5051                       |
| §15.2 displayname                                            | 5055                            |
| §15.7 getlastmodified（仅在 GET 返回 Last-Modified 时 MUST） | 5230-5232                       |
| §15.9 resourcetype（MUST 定义）                              | 5343-5344                       |

RFC 4918 全文由 `curl https://www.rfc-editor.org/rfc/rfc4918.txt` 下载，保存在 `.temp/rfc4918.txt`（临时文件，可随时重新获取）。
