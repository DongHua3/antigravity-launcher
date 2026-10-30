# Third-party notices

本项目的部分代码与资源来自第三方，按 MIT 许可使用。以下声明必须随源码与二进制一起分发。

## 1. 派生自的启动器项目

部分后端结构（会话生命周期、CDP 注入框架、设置与原子存储）派生自一个 MIT 许可的
Antigravity 启动器项目：

- 来源：https://github.com/DSDS-CMHL/EasyAntigravity
- 原始版权：Copyright (c) 2026 Astwarp

本项目已重命名、删除上下文统计与权限相关模块、重写界面与文档，并对回环 API 与更新通道做了加固；
上述来源仅用于满足 MIT 许可的署名要求。

## 2. 汉化词典

`dicts/` 下的词条由社区整理，原始整理者包括 nicktan @ linux.do
（https://linux.do/t/topic/2896116）。词条内容按原样或经删改后使用。

## 3. ws

`node_modules/ws`（打包进 `backend/`）用于 CDP WebSocket 连接。

- 项目：https://github.com/websockets/ws
- 许可：MIT，Copyright (c) 2011 Einar Otto Stangvik

## 4. Node.js 运行时

发行包内的 `agl-node` 是 Node.js 运行时的副本，遵循其自身许可（MIT 及第三方组件声明），
随包附带 `NODE-LICENSE.txt`。

---

MIT License 全文见 [LICENSE](LICENSE)。
