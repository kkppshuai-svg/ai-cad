# HTTP API

## 1. 基础信息

- 默认地址：`http://127.0.0.1:3101`
- 内容类型：`application/json`
- 实时事件：Server-Sent Events（SSE）
- 设计范围：可信本机客户端，不是公网多用户 API

## 2. 请求令牌

先请求状态接口：

```bash
curl http://127.0.0.1:3101/api/status
```

从响应读取 `requestToken`，在后续 POST 请求中发送：

```http
X-AI-CAD-Token: <requestToken>
```

服务重启后令牌变化，客户端不得持久化旧令牌。

## 3. 路由

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/status` | 运行状态、模型、工具链、限制和请求令牌 |
| POST | `/api/chat` | 新建设计或继续参数化对话 |
| POST | `/api/chat/stop` | 停止指定会话的当前规划任务 |
| GET | `/api/assembly/latest` | 恢复最近的已保存装配任务 |
| GET | `/api/assembly/:id` | 获取任务、当前修订、产物和验证摘要 |
| GET | `/api/assembly/:id/feature-tree` | 获取带构建状态的特征树 |
| GET | `/api/assembly/:id/validation` | 获取验证、修复审计和约束报告 |
| GET | `/api/assembly/:id/revisions` | 获取修订列表 |
| POST | `/api/assembly/:id/edit` | 应用局部 `editPatch` |
| POST | `/api/assembly/:id/revert` | 回退到指定修订 |
| POST | `/api/assembly/repair` | 重新构建 `validation_failed` 任务 |
| POST | `/api/visual-review` | 对当前工程预览执行视觉审查 |
| POST | `/api/visual-review/repair` | 将审查报告转为内部修复轮次 |
| POST | `/api/visual-review/improve` | 选择可操作发现并生成验证后的修订 |
| POST | `/api/preview` | 从零件特征 JSON 构建临时预览 |
| POST | `/api/search` | 搜索 CAD 参考资料 |
| POST | `/api/explorer-link` | 为产物生成 CAD Explorer 链接 |
| GET | `/api/latent/training` | 查询 latent 训练状态 |
| POST | `/api/latent/retrain` | 立即触发训练，返回 202 |
| POST | `/api/rate` | 保存人工评分 |
| GET/POST | `/api/training/session` | 恢复或保存连续训练会话 |
| GET | `/api/events` | 订阅 SSE 事件流 |

`POST /api/generate` 是面向底层计划生成的兼容入口；正常产品链路应优先使用 `/api/chat`。

## 4. 典型请求

### 新建或继续对话

```json
{
  "conversationId": "optional-stable-id",
  "message": "生成一个 80 × 50 × 8 mm 安装板",
  "activePartId": null,
  "activeFeatureId": null,
  "webSearch": { "enabled": false },
  "images": [],
  "fbs": null
}
```

`conversationId` 缺失时服务器生成新 ID。`images` 最多 3 张，支持 PNG、JPEG、WebP；文字说明优先于图片推断。

### 停止当前规划

```json
{ "conversationId": "conversation-id" }
```

该操作停止 `planner:<conversationId>` 对应的 harness 任务。已经进入 CadQuery 子进程的阶段可能需要由构建流程自行结束。

### 局部编辑

```json
{
  "baseRevision": "revision-id",
  "operations": [
    {
      "op": "set_param",
      "partId": "mount_plate",
      "featureId": "mount_plate.hole.01",
      "path": "params.diameter",
      "value": 6
    }
  ]
}
```

也可用 `{ "editPatch": { ... } }` 包装。若 `baseRevision` 不是当前修订，返回 409 和 `STALE_REVISION`。

### 回退修订

```json
{ "revisionId": "target-revision-id" }
```

目标修订必须具有完整 plan、验证和约束状态。

### 重新构建失败任务

```json
{
  "assemblyId": "failed-assembly-id",
  "conversationId": "optional-conversation-id"
}
```

只有状态为 `validation_failed` 的任务可使用该路由；其他状态返回 409。

## 5. 状态码

| 状态码 | 含义 |
| ---: | --- |
| 200 | 请求完成；仍需检查业务 `status` 和验证报告 |
| 202 | 训练任务已接受，尚未完成 |
| 400 | 缺少字段、JSON 或输入格式错误 |
| 403 | Host、Origin、远程访问或令牌校验失败 |
| 404 | 路由、任务或修订不存在 |
| 409 | 陈旧修订、过期审查或当前状态不允许操作 |
| 413 | 请求体或图片超过限制 |
| 422 | 候选可解析但验证失败或无法执行改进 |
| 500 | 未处理的内部错误 |

错误响应至少包含 `error`，部分错误包含稳定 `code`。客户端不能只凭 HTTP 200 判定 CAD 修订已经晋级。

## 6. SSE

`GET /api/events` 提供进度事件，常见类型包括：

- `search:done`
- `assembly:progress`
- `assembly:repair`
- `assembly:done`
- `assembly:error`
- `assembly:review_done`
- `latent:training:queued`
- `latent:training:failed`

SSE 用于展示进度；最终状态仍以任务查询和修订存储为准。客户端重连后应重新获取当前任务。

