# 安装与运行

[中文首页](../README.zh-CN.md) · [English guide](getting-started.en.md)

## 1. 环境要求

| 组件 | 要求 | 用途 |
| --- | --- | --- |
| 操作系统 | Linux 或 Windows | 安装步骤分别见下文；Windows 使用显式 Python 路径 |
| Node.js | 20 或更高版本 | Web 服务、前端依赖和测试 |
| Python | Python 3，支持 `venv` | CadQuery、OCP 和训练脚本 |
| 模型提供器 | AI 功能需要配置 | 默认 Codex，支持按配置使用 DeepSeek；确定性示例无需 AI 调用 |
| USD BRep | 可选，独立 Python 3.12 环境 | NVIDIA 原生实体与精确 USD 导出 |
| FreeCAD | 可选，提供 `freecadcmd` | FCStd/FreeCAD 桥接与后续编辑 |

## 2. 获取源码

```bash
git clone https://github.com/kkppshuai-svg/ai-cad.git
cd ai-cad
```

需要 FBS 独立基线时使用：

```bash
git switch feature/fbs-system
```

## 3. 安装依赖

Linux：

```bash
npm ci
bash scripts/setup_cadquery_env.sh
```

脚本创建 `.venv-cadquery/`，安装 `requirements-cadquery.txt`，并在缺失时生成 `.env.local`。机器专用路径应写入 `.env.local`，不要写入代码默认值。

Windows PowerShell：

```powershell
npm ci
py -3.12 -m venv .venv-cadquery
& ./.venv-cadquery/Scripts/python.exe -m pip install -r requirements-cadquery.txt
$env:CADQUERY_PYTHON = (Resolve-Path ./.venv-cadquery/Scripts/python.exe).Path
npm start
```

上述环境变量对当前终端有效。需要持久配置时，在 `.env.local` 保存 `CADQUERY_PYTHON`。默认服务地址为 `http://127.0.0.1:3101`。

确认关键程序：

```bash
node --version
.venv-cadquery/bin/python -c "import cadquery; print(cadquery.__version__)"
codex --version
freecadcmd --version
```

FreeCAD 为可选项；未安装时基础 CadQuery 构建仍可运行，但相关桥接产物可能不可用。

## 4. 启动与停止

```bash
bash launch-ai-cad.sh  # Linux 后台启动并打开浏览器
npm start              # 前台启动，便于查看日志
npm run dev            # Node watch 模式
bash stop-ai-cad.sh    # Linux 停止后台服务
```

默认地址为 `http://127.0.0.1:3101`。后台服务日志位于 `logs/ai-cad.log`。

## 5. 首次验证

先在页面点击“加载带孔板示例”。该路径使用确定性特征计划，无需调用 AI。点击“统一审查”时，可选择“仅核对几何证据”；完整交付范围还会调用视觉提供器。

未配置 USD BRep 时使用 CadQuery。配置 `USD_BREP_PYTHON` 指向已安装 `requirements-usd-brep.txt` 的 Python 3.12 环境后，可选择 NVIDIA 原生模式；可用时默认选用，用户选择会保留。安装和当前特征范围见 [USD BRep 接入](usd-brep.md)。

```bash
npm run check
curl http://127.0.0.1:3101/api/status
```

在界面输入：

```text
生成一个 80 × 50 × 8 mm 的矩形安装板，中心有一个直径 10 mm 的贯穿孔，四角各有一个直径 5 mm 的安装孔，孔中心距相邻边 8 mm。
```

CadQuery 参数化构建可产生修订、特征树、验证摘要和 STEP；NVIDIA 原生预览产生精确 USD BRep 和 STL，不提供 STEP/FCStd。`assemblies/` 保存构建证据。模型已显示不等于完整交付通过，以[统一审查](unified-brep-review.md)的几何和当前视觉结论为准。

## 6. 常见问题

### 页面显示 API route not found

通常是浏览器连接了旧服务或错误端口。停止旧服务，重新运行 `./launch-ai-cad.sh`，并以终端输出的地址为准。

### Codex 提示未知 feature flag 或 reasoning effort

检查 `CODEX_BIN` 是否指向当前登录且版本匹配的 Codex CLI。先运行 `codex --version`，再查看 `/api/status` 的 `codexBin`、`codexModel` 和 `codexReasoningEffort`。

### 构建失败但界面仍有预览

失败预览是诊断证据，不代表修订已通过。以 `validationReport.blockingErrorCount` 和当前修订状态为准。

### 端口被占用

后台脚本会在有限候选端口中寻找当前版本服务。前台启动时可在 `.env.local` 设置其他 `PORT`。
