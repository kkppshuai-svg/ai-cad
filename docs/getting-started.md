# 安装与运行

## 1. 环境要求

| 组件 | 要求 | 用途 |
| --- | --- | --- |
| 操作系统 | Ubuntu 22.04 或兼容 Linux | 当前主要研发环境 |
| Node.js | 20 或更高版本 | Web 服务、前端依赖和测试 |
| Python | Python 3，支持 `venv` | CadQuery、OCP 和训练脚本 |
| Codex CLI | 已安装并完成登录 | 默认规划、修复和视觉审查模型入口 |
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

```bash
npm install
chmod +x scripts/setup_cadquery_env.sh launch-ai-cad.sh stop-ai-cad.sh
./scripts/setup_cadquery_env.sh
```

脚本创建 `.venv-cadquery/`，安装 `requirements-cadquery.txt`，并在缺失时生成 `.env.local`。机器专用路径应写入 `.env.local`，不要写入代码默认值。

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
./launch-ai-cad.sh     # 后台启动并打开浏览器
npm start              # 前台启动，便于查看日志
npm run dev            # Node watch 模式
./stop-ai-cad.sh       # 停止后台服务
```

默认地址为 `http://127.0.0.1:3101`。后台服务日志位于 `logs/ai-cad.log`。

## 5. 首次验证

```bash
npm run check
curl http://127.0.0.1:3101/api/status
```

在界面输入：

```text
生成一个 80 × 50 × 8 mm 的矩形安装板，中心有一个直径 10 mm 的贯穿孔，四角各有一个直径 5 mm 的安装孔，孔中心距相邻边 8 mm。
```

成功结果应包含当前修订、参数化特征树、验证摘要和至少一个 STEP 产物。`assemblies/` 下会保存对应构建证据。

## 6. 常见问题

### 页面显示 API route not found

通常是浏览器连接了旧服务或错误端口。停止旧服务，重新运行 `./launch-ai-cad.sh`，并以终端输出的地址为准。

### Codex 提示未知 feature flag 或 reasoning effort

检查 `CODEX_BIN` 是否指向当前登录且版本匹配的 Codex CLI。先运行 `codex --version`，再查看 `/api/status` 的 `codexBin`、`codexModel` 和 `codexReasoningEffort`。

### 构建失败但界面仍有预览

失败预览是诊断证据，不代表修订已通过。以 `validationReport.blockingErrorCount` 和当前修订状态为准。

### 端口被占用

后台脚本会在有限候选端口中寻找当前版本服务。前台启动时可在 `.env.local` 设置其他 `PORT`。
