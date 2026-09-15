# 配置参考

AI-CAD 启动时读取仓库根目录 `.env.local`。该文件包含机器路径和密钥，必须保持在 Git 忽略列表中。

## 1. 最小配置

```dotenv
HOST=127.0.0.1
PORT=3101
CADQUERY_PYTHON=/absolute/path/to/ai-cad/.venv-cadquery/bin/python
FREECAD_CMD=freecadcmd
CODEX_BIN=codex
AICAD_CODEX_MODEL=gpt-6-astra
AICAD_CODEX_REASONING_EFFORT=medium
AICAD_LLM_PROVIDER=codex
```

## 2. 服务与安全

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `3101` | HTTP 端口 |
| `AICAD_ALLOW_REMOTE` | 关闭 | 允许非本机请求；只应在可信网络启用 |
| `AICAD_MAX_JSON_BODY_BYTES` | `4000000` | JSON 请求体上限，范围 1 KB–16 MB |
| `AICAD_MAX_CHAT_IMAGES` | `3` | 单次聊天图片上限，范围 1–6 |
| `AICAD_MAX_CHAT_IMAGE_BYTES` | `2000000` | 单张聊天图片上限 |
| `AICAD_MAX_VISUAL_REVIEW_IMAGES` | `6` | 视觉审查图片上限，范围 1–8 |
| `AICAD_MAX_VISUAL_REVIEW_IMAGE_BYTES` | `1500000` | 单张审查图片上限 |

服务默认拒绝远程请求，并校验 Host、Origin 和状态修改请求令牌。启用远程访问不等于具备公网部署安全性；当前系统没有账户、租户、TLS 或权限模型。

## 3. CAD 工具链

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CADQUERY_PYTHON` | `.venv-cadquery/bin/python` | CadQuery/OCP Python |
| `FREECAD_CMD` | `freecadcmd` | FreeCAD 命令行程序 |
| `AICAD_CAD_EXPLORER_SKILL_DIR` | 自动解析 | CAD Explorer skill 位置 |

`AICAD_CADQUERY_PYTHON` 只用于现有 FreeCAD 集成测试兼容；服务器运行时的权威变量是 `CADQUERY_PYTHON`。

## 4. LLM 路由

### Codex

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEX_BIN` | `codex` | Codex CLI 命令或绝对路径 |
| `AICAD_CODEX_MODEL` | `gpt-6-astra` | 规划、修复和审查模型 |
| `AICAD_CODEX_REASONING_EFFORT` | `medium` | `low`、`medium`、`high`、`xhigh`、`max` |
| `AICAD_CODEX_HARNESS` | app-server | 设为 `exec` 可关闭持久 harness |
| `AICAD_CODEX_HARNESS_STRICT` | `0` | `1` 表示 harness 失败时不回退 CLI exec |

### DeepSeek

```dotenv
AICAD_LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-...
AICAD_DEEPSEEK_MODEL=deepseek-chat
AICAD_DEEPSEEK_VISION=auto
```

| 变量 | 说明 |
| --- | --- |
| `AICAD_LLM_PROVIDER` | `codex` 或 `deepseek` |
| `AICAD_LLM_STRICT` | `1` 时禁止回退 Codex |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `AICAD_DEEPSEEK_BASE_URL` | 兼容端点，默认官方 API |
| `AICAD_DEEPSEEK_MODEL` | DeepSeek 模型名 |
| `AICAD_DEEPSEEK_VISION` | `auto`、启用或关闭图片能力声明 |
| `AICAD_DEEPSEEK_TIMEOUT_MS` | 请求超时 |
| `AICAD_DEEPSEEK_JSON_MODE` | `1` 时请求 JSON object 响应 |
| `AICAD_DEEPSEEK_TEMPERATURE` | 采样温度 |
| `AICAD_DEEPSEEK_MAX_TOKENS` | 最大输出 token |

DeepSeek 未配置 key，或图片请求遇到无视觉能力模型时，系统默认回退 Codex；`AICAD_LLM_STRICT=1` 会将这些情况改为显式失败。

## 5. 超时

| 变量 | 默认值（ms） | 范围（ms） |
| --- | ---: | ---: |
| `AICAD_CODEX_TIMEOUT_MS` | 300000 | 60000–600000 |
| `AICAD_CODEX_IMAGE_TIMEOUT_MS` | 360000 | 120000–900000 |
| `AICAD_CODEX_EDIT_TIMEOUT_MS` | 90000 | 30000–180000 |
| `AICAD_CODEX_EDIT_RETRY_TIMEOUT_MS` | 45000 | 20000–120000 |
| `AICAD_CODEX_VISUAL_REVIEW_TIMEOUT_MS` | 360000 | 120000–900000 |

不要仅通过持续增加超时掩盖死循环或模型配置错误。先检查日志、模型版本和输入规模。

## 6. 搜索

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AICAD_WEB_SEARCH_PROVIDER` | `anysearch` | `anysearch`、`tavily`、`bing-cn`、`sogou`、`china` |
| `ANYSEARCH_API_KEY` | 空 | AnySearch key，可选 |
| `TAVILY_API_KEY` | 空 | Tavily key |
| `AICAD_WEB_SEARCH_MAX_RESULTS` | `5` | 范围 1–8 |
| `AICAD_WEB_SEARCH_TIMEOUT_MS` | `5000` | 范围 2000–30000 |
| `AICAD_WEB_SEARCH_CURL_FALLBACK` | 自动 | 控制 curl 回退 |
| `AICAD_WEB_SEARCH_LOCAL_FIRST` | 默认策略 | 控制本地参考优先级 |

搜索结果只提供参考，不能覆盖用户明确尺寸或已确认标准件型号。

## 7. 数据目录与训练

| 变量 | 默认目录/值 |
| --- | --- |
| `AICAD_CONVERSATION_DIR` | `aicad建模反馈/` |
| `AICAD_CADQUERY_SCRIPT_DIR` | `cadquery底层脚本库/` |
| `AICAD_RATING_DIR` | `aicad人工评分/` |
| `AICAD_TRAINING_DIR` | `aicad训练记录/` |
| `AICAD_FBS_DIR` | `aicad-fbs-experiments/` |
| `AICAD_EXCELLENT_CADQUERY_DIR` | `人工优秀代码库/` |
| `AICAD_LATENT_RUNTIME_DIR` | `workspace/latent-learning/` |
| `AICAD_LATENT_VAE_EPOCHS` | `120`，范围 20–2000 |

目录变量可以使用绝对路径。迁移时应将源码与运行数据分别备份，避免把大型产物提交到 Git。
