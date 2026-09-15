# AI-CAD 迁移说明

本文档用于将 AI-CAD 源码和可选研发数据迁移到新的 Ubuntu 22.04 环境。源码与运行数据应分开处理。

## 1. 迁移范围

必须迁移：

- Git 仓库中的源码和文档；
- 本机未推送的有效 Git 提交；
- 新机器需要的 `.env.local` 配置值（通过安全渠道手工重建）。

按需迁移：

- `assemblies/` 中需要保留的修订和 STEP 产物；
- `aicad建模反馈/`、`aicad训练记录/`、`aicad人工评分/`；
- `aicad-fbs-experiments/`；
- `workspace/latent-learning/` 和自建训练数据；
- `人工优秀代码库/`、`cadquery底层脚本库/`。

不应迁移或提交到 Git：

- `.venv-cadquery/`、`node_modules/`；
- `logs/`、临时上传、渲染缓存；
- 失效 PID 文件；
- API key、请求令牌和其他密钥。

## 2. 推送旧机器源码

```bash
cd /path/to/ai-cad
git status
git remote -v
git push github master
```

当前 GitHub 仓库：

```text
https://github.com/kkppshuai-svg/ai-cad
```

提交前必须检查变更范围；不要直接使用 `git add .` 将运行目录、密钥或无关实验数据混入提交。

## 3. 安装基础环境

```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip
```

另行安装 Node.js 20+ 和 Codex CLI，并完成 Codex 登录。FreeCAD 为可选依赖；如需 FCStd 和 FreeCAD 桥接，确保 `freecadcmd` 可执行。

当前核心只需要参数化 CAD、BREP 验证和可选 FreeCAD 桥接相关运行时。

## 4. 克隆与安装

```bash
git clone https://github.com/kkppshuai-svg/ai-cad.git
cd ai-cad
npm install
chmod +x scripts/setup_cadquery_env.sh launch-ai-cad.sh stop-ai-cad.sh
./scripts/setup_cadquery_env.sh
```

编辑 `.env.local`，将 `CADQUERY_PYTHON`、`CODEX_BIN` 和 `FREECAD_CMD` 设置为新机器真实路径。密钥只能写入 `.env.local` 或系统安全凭据，不得提交。

## 5. 恢复运行数据

先在旧机器停止 AI-CAD，再复制需要保留的目录。不要在服务运行时复制正在写入的修订目录。

恢复后检查所有绝对路径。旧修订可能包含旧机器产物路径；若无法复用，应保留计划和报告作为档案，并在新机器重新构建，不要手工篡改为“已通过”。

## 6. 验证新环境

```bash
npm run check
./launch-ai-cad.sh
curl http://127.0.0.1:3101/api/status
```

随后在界面生成一个简单安装板，确认：

- Codex/所选 LLM 能返回计划；
- CadQuery 能生成 STEP；
- 验证报告包含 BREP 和 STEP round-trip 证据；
- 当前修订成功晋级；
- 浏览器可以加载 GLB/STL 预览；
- 停止按钮和 `./stop-ai-cad.sh` 均有效。

## 7. 桌面快捷方式（可选）

创建 `AI-CAD.desktop`，使用新机器的绝对路径：

```ini
[Desktop Entry]
Type=Application
Name=AI-CAD 参数化建模工作台
Exec=/absolute/path/to/ai-cad/launch-ai-cad.sh
Icon=/absolute/path/to/ai-cad/public/icon.svg
Terminal=false
Categories=Graphics;Engineering;
StartupNotify=true
```

赋予执行权限后再从桌面启动。若桌面环境不允许直接执行，应在文件属性中启用“允许作为程序执行”。

## 8. 回滚

迁移失败时不要删除旧机器数据。优先：

1. 保留旧环境只读快照；
2. 在新机器检出已知成功提交；
3. 重新创建 Python 和 Node 依赖；
4. 恢复 `.env.local`；
5. 重新构建关键模型并比较验证报告。

运行数据与源码版本不兼容时，以 Git 中的 schema 和迁移前验证报告为依据，不要强制把失败修订设为 current。
