# AI-CAD

**本地 AI 参数化建模与几何审查工作台。**

[English](README.en.md) · [安装与运行](docs/getting-started.md) · [文档中心](docs/README.md)

通过文字或参考图创建和修改 CAD 模型，在三维视图中检查结果，并随修订保留审查证据。

![AI-CAD 行星减速机工作台示例](docs/assets/examples/planetary-reducer.png)

*研发过程截图。[更多示例](docs/examples.md)*

## 功能

- 稳定特征计划、局部参数修改与版本历史。
- NVIDIA USD BRep 原生建模；更广的零件与装配使用 CadQuery/OpenCascade。
- BRep 与视觉联合审查、产物完整性检查及验证门禁。
- 按后端导出精确 USD 或 STEP，提供预览网格及可选 FreeCAD 接入。

**技术栈：** Node.js · Three.js · Python · CadQuery/OpenCascade · NVIDIA USD BRep（可选）。

## 快速开始

需要 Node.js 20+、支持 `venv` 的 Python。Linux：

```bash
git clone https://github.com/kkppshuai-svg/ai-cad.git
cd ai-cad
npm ci
bash scripts/setup_cadquery_env.sh
npm start
```

打开 `http://127.0.0.1:3101`，加载带孔板示例。[Windows 与后端配置](docs/getting-started.md)

## 文档

- [配置](docs/configuration.md) · [HTTP API](docs/api.md)
- [统一审查](docs/unified-brep-review.md) · [USD BRep 接入](docs/usd-brep.md)
- [开发与测试](docs/development.md) · [问题反馈](https://github.com/kkppshuai-svg/ai-cad/issues)

## 相关项目

- [FormaLatent · 形潜](https://github.com/kkppshuai-svg/formalatent)：CAD 神经表征与相似检索。
- [USD BRep Review](https://github.com/kkppshuai-svg/usd-brep-review)：独立原生 BRep 与视觉审查通道。

项目处于工程研发阶段，审查结果不能替代实际载荷或制造验证。参见[验证范围](docs/validation-and-repair.md)。
