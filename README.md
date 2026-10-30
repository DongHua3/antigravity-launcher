# AG Launcher

Antigravity 的轻量启动器：可选的进程级代理、可逆界面汉化、托盘常驻。不修改 Antigravity 安装包，不写它的配置目录。

```
启动器面板 ──HTTP(127.0.0.1, 令牌)──► 本地后端
                                        │ spawn
                                        ▼
                                   Antigravity ──CDP──► 汉化注入（可撤销）
```

## 功能

- **启动目标选择**：桌面版 / IDE 版，自动发现安装位置；找不到时才弹路径设置。
- **可逆界面汉化**：通过 CDP 注入一段自包含脚本做 DOM 翻译，关闭开关立即还原原文；只改文本节点与 `placeholder/title/aria-label`。
- **可选进程代理**：把 `--proxy-server` 与 `HTTP(S)_PROXY` 只注入到 Antigravity 子进程。常开 TUN / 全局代理的用户建议关掉。
- **托盘常驻**：关窗口不退出；托盘菜单可显示窗口、打开面板、彻底退出。
- **热更新**：只更新词典与内核 JS（`runtime/current` overlay），逐文件 SHA-256 校验，启动失败自动回退内置代码。
- **本地安全默认**：面板 API 需要每次启动生成的能力令牌；更新源固定为 https + 主机白名单。

## 运行

需要 Node.js ≥ 22。

```sh
npm ci
npm start
```

启动后终端会打印带令牌的面板地址（`http://127.0.0.1:<port>/#token=…`）。手敲不带 `#token` 的地址会被拒绝——令牌只在下发时出现一次。

构建原生外壳（窗口/托盘、内置 Node 运行时）需要 Rust 与各平台构建依赖：

```sh
npm run tauri build
```

## 使用

1. 打开面板，按需设置代理端口（或关闭代理）。
2. 选择「桌面版 / IDE 版」，点击启动。若 Antigravity 已在运行，请先退出。
3. 汉化开关立即生效；关闭会把页面文本还原。
4. 退出：托盘菜单 → 退出应用。

IDE 版只支持启动与代理配置，不做界面汉化。

## 数据与配置

| 内容 | 位置 |
|---|---|
| 设置 | `<数据目录>/settings.json` |
| 日志 | `<数据目录>/agl.log`（2 MB 轮转） |
| 词典热更新 | `<数据目录>/hotfix/dicts/` |
| 内核 overlay | `<数据目录>/runtime/current/` |

数据目录：Tauri 模式为系统的应用数据目录（`identifier` 对应的 `app_local_data_dir`），独立运行时为程序所在目录，可用 `AGL_DATA_DIR` 覆盖。

环境变量：

| 变量 | 作用 |
|---|---|
| `AGL_DATA_DIR` | 覆盖数据目录 |
| `AGL_DISABLE_OVERLAY=1` | 不加载内核 overlay，只用内置代码 |
| `AGL_UPDATE_URL` | 覆盖更新清单地址（仍受 https + 主机白名单约束） |
| `AGL_TEST_MODE=1` | 测试用：不启动真实程序、不打开浏览器 |

## 更新机制

`update-manifest.json` 列出词典与内核文件的 SHA-256。应用只从 `raw.githubusercontent.com` / `github.com` / `objects.githubusercontent.com` 拉取，且只允许写入 `core/ features/ adapters/ desktop/ ui/ dicts/` 下的 `.js/.json/.css/.html`。

要把更新源换成自己的仓库：修改 `features/updater.js` 里的 `DEFAULT_MANIFEST_URL` 与 `UPDATE_HOSTS`，再运行 `npm run build:manifest` 生成清单。

> 注意：清单与文件来自同一个源，SHA-256 只能防传输损坏，不是签名。需要更强保证时请自行加签名校验，或设置 `AGL_DISABLE_OVERLAY=1`。

## 开发

```sh
npm run check                 # 语法检查
npm test                      # 单元 + 集成冒烟
npm run test:tauri-lifecycle  # 打包后的后端生命周期（约 40 秒）
npm run test:launcher:browser -- "<浏览器可执行文件路径>"   # 面板 UI 回归
```

## 许可

MIT。第三方来源与版权声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
本项目与 Google 无关；Antigravity 是其各自权利人的产品。
