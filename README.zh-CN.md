# Time Changer —— Steam Deck 时间修改插件

[English](README.md)

一个 [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) 插件：在游戏模式下一键修改 Steam Deck 系统时间 —— 快捷偏移、自定义日期时间、一键恢复 NTP 校准。

无需切换桌面模式、无需终端，直接在快捷菜单（QAM）里操作。适合有日期触发内容的游戏（每日活动、日期成就）、依赖现实时钟的模拟器游戏，以及开发测试。

## 功能

- 实时显示系统时间与 NTP 同步状态
- 快捷偏移：±30分钟 / ±1小时
- 自定义日期时间选择器 —— 默认当前时间，自动处理大小月和闰年
- 一键恢复真实时间（重新开启 NTP 自动校准）
- 界面支持 English / 简体中文，跟随 Steam 客户端语言

## 原理

Python 后端以 root 运行（`plugin.json` 中 `flags: ["root"]`），封装 `timedatectl`：

| 操作 | 命令 |
|---|---|
| 修改时间 | `timedatectl set-ntp false` → `timedatectl set-time @<epoch>`（UTC 秒数，与时区无关） |
| 恢复 | `timedatectl set-ntp true` —— 联网后 systemd-timesyncd 自动校准 |

## 安装

### 通过 URL 安装（推荐，无需桌面模式）

1. 从 [Releases](../../releases) 下载 `decky-time-changer-v*.zip`，或托管在 Deck 可访问的任意 HTTP 服务上
2. Deck 上打开 Decky 菜单 → ⚙️ 设置 → **GENERAL** → **DEVELOPER**（若不可见，先开启 Developer Mode）
3. 点击 **Install plugin from URL**，粘贴 zip 的 URL

### 从源码构建

```bash
git clone https://github.com/nanwangjkl/decky-time-changer.git && cd decky-time-changer
pnpm install && pnpm run build   # 产出 dist/
./deploy.sh zip                  # 打包 out/decky-time-changer-v*.zip
```

## 注意事项

- **时间偏差期间 HTTPS 校验会失败** —— Steam 商店/联网功能可能异常，属正常现象，点「恢复真实时间」即可
- 恢复需要联网（NTP 需访问时间服务器）
- Steam 客户端显示的时间可能要重启 Steam 才刷新，系统时间本身已立即改变
- 修改时间会自动关闭 NTP（避免被自动同步回去），插件会显示「手动时间」状态提醒你

## 开发

环境要求：Node ≥ 18、pnpm ≥ 8、Python 3（后端仅在 Deck 上运行）。

```bash
pnpm run check      # 类型检查 + 前后端/部署回归测试 + Shell 语法检查
./deploy.sh          # 构建 + rsync 到 Deck + 重启 plugin_loader
./deploy.sh zip      # 打包可安装的 zip 到 out/
./deploy.sh restart  # 仅重启 Deck 上的 plugin_loader
```

连接参数来自环境变量（`DECK_IP`、`DECK_USER`、`DECK_PORT`、`DECK_KEY`/`DECK_PASS`）或 `.deploy.env` 文件，详见 `deploy.sh`；也可使用 `.vscode/tasks.json` 中的 VSCode 任务。

后端日志在 Deck 上：`~/homebrew/logs/decky-time-changer/plugin.log`。

回归测试使用模拟的 Decky API、系统命令和 SSH，不会修改本机或 Deck 的系统时间。

### 项目结构

```
plugin.json          插件元数据（root flag）
main.py              Python 后端 —— timedatectl 封装
src/index.tsx        前端 UI（@decky/ui）
src/translations.ts  英文/简体中文词典
dist/                前端构建产物（rollup）
deploy.sh            构建部署脚本
```

## 许可证

BSD 3-Clause，见 [LICENSE](LICENSE)。
