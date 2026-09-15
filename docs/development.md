# 开发与测试

## 1. 开发基线

```bash
npm install
./scripts/setup_cadquery_env.sh
npm run check
```

建议从 `codex/` 前缀分支开发。不要把 `.env.local`、虚拟环境、构建产物、个人训练记录或标准件缓存提交到 Git。

## 2. 代码结构

```text
public/                     浏览器 UI 与 Three.js 工程预览
server.js                   HTTP/SSE 入口与运行时装配
conversation-turn.js        对话、FBS 和修复编排
assembly-build.js           构建与修订晋级
parametric-*.js             计划、编辑及参数化 API
cad-validation.js           验证门禁与确定性修复
validation-repair-loop.js   有界自动修复循环
revision-store.js           修订持久化与回退
scripts/cadquery_build.py   CadQuery/OCP 构建器
cad-latent-training.js      latent/VAE 在线样本管线
docs/                       工程文档与架构规范
agents/aicad/               AI-CAD agent 封装
```

## 3. 检查命令

```bash
npm run check
```

完整检查包含 Node 语法检查、Python 编译检查、Python 单元测试、CadQuery 构建测试和全部 `.test.mjs` 回归。开发中可运行定向测试：

```bash
node --test fbs-workflow.test.mjs prompt-contract.test.mjs
node --test cad-validation.test.mjs validation-repair-loop.test.mjs
node --test parametric-edit.test.mjs parametric-api.test.mjs
node --test api-routes.test.mjs security.test.mjs
```

## 4. 变更要求

### 参数化特征

- 新特征必须具有稳定 ID、依赖关系和规范化参数；
- 构建器、schema、提示合同、验证器和前端展示应同步支持；
- 删除特征必须先处理依赖节点，不能留下悬空引用；
- 新增几何能力必须有成功构建和失败边界测试。

### API

- 更具体路由必须声明在宽泛前缀之前；
- POST 请求必须走现有令牌、Origin 和 body-size 校验；
- 新错误使用稳定 code，并记录到 `docs/api.md`；
- 状态修改必须处理并发修订和 stale revision。

### 验证与修复

- 不得通过降低 error 严重级别来“修复”问题；
- 自动修改必须有审计记录，并在真实重建后验证；
- 新修复动作必须证明不会改变受保护功能语义；
- 根因压缩只能减少重复报告，不能隐藏独立错误。

## 5. 样本回归与 latent/VAE

```bash
npm run train:10
npm run train:30
npm run train:50
```

这些命令是工程样本回归，不是大模型权重微调。BREP VAE 使用几何描述和已接受样本学习结构模式：

```bash
.venv-cadquery/bin/python scripts/extract_brep_geometry.py \
  --dataset cad-latent/training_samples.jsonl \
  --assemblies assemblies \
  --out cad-latent/brep_training_samples.jsonl

.venv-cadquery/bin/python scripts/train_brep_vae.py \
  --dataset cad-latent/brep_training_samples.jsonl \
  --out cad-latent/brep_vae_model.json
```

只有通过验证并晋级的修订可以进入自动学习队列。训练结果用于检索和提示参考，不能覆盖当前用户的明确尺寸和功能意图。

## 6. 文档与架构图

架构源在 `docs/architecture/*.json`；本地配置了 Archify skill 时可运行：

```bash
npm run architecture
```

生成后应检查 `public/architecture.html` 是否能离线打开、节点文案是否与当前模块一致。若开发环境没有该 skill，代码与测试仍可正常工作。

## 7. 提交前清单

- [ ] 变更范围明确，没有混入运行产物或个人路径；
- [ ] `git diff --check` 通过；
- [ ] 相关定向测试通过；
- [ ] `npm run check` 通过，或在提交说明中记录明确阻断原因；
- [ ] API、环境变量、验证规则和 schema 变化已同步文档；
- [ ] 没有提交 API key、令牌、上传图片或训练数据；
- [ ] 失败候选不会替换当前成功修订。

