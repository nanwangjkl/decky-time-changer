# Time Changer (decky-time-changer)

一个 Decky Loader 插件：在 Steam Deck 上一键修改系统时间。

功能：

- 显示当前系统时间与 NTP 同步状态
- 快捷偏移：+1小时 / +6小时 / +12小时 / +1天 / +7天 / -1小时 / -1天
- 滑条按偏移量调整（±30 天，步长 1 小时），实时预览目标时间
- 自定义精确时间（`YYYY-MM-DD HH:MM`）
- 一键恢复真实时间（重新开启 NTP 自动校准）

原理：后端以 root 运行（`plugin.json` 中 `flags: ["root"]`），调用
`timedatectl set-ntp false` + `timedatectl set-time @<epoch>` 修改系统时间；
恢复时 `timedatectl set-ntp true`。

## 开发环境

- Node.js ≥ 18、pnpm ≥ 8、Python 3（本机仅需构建前端，后端在 Deck 上运行）

## 构建与部署

1. 复制 `.vscode/defsettings.json` 为 `.vscode/settings.json`（或项目根 `.deploy.env`），
   填入 Deck 的 IP、密码或 SSH key。
2. 命令行部署：

   ```bash
   ./deploy.sh          # 构建 + rsync 到 Deck + 重启 plugin_loader
   ./deploy.sh zip      # 打包可手动安装的 zip 到 out/
   ./deploy.sh restart  # 仅重启 Deck 上的 plugin_loader
   ```

   或在 VSCode 中运行任务 `build` / `deploy` / `restart-decky`。

3. 在 Deck 上打开快捷菜单（...）→ 插件图标 → Time Changer。

首次部署前需要：

- Deck 上已安装 Decky Loader，并开启了 SSH（桌面模式设置中开启）。
- 本机能 SSH 到 Deck（推荐 `ssh-copy-id deck@<deck-ip>` 免密；或安装 sshpass 使用密码）。

## 注意事项 / 风险

- **修改时间后 HTTPS 可能失效**：时间偏差过大时 TLS 证书校验失败，Steam
  商店/联网功能可能异常，属正常现象，恢复真实时间即可。
- **恢复需要联网**：NTP 校准依赖网络；无网络时只会重新开启 NTP，等联网后自动校准。
- Steam 客户端内显示的时间可能需要重启 Steam 才刷新（系统时间已实际改变）。

## 项目结构

```
plugin.json   插件元数据（flags 含 root）
main.py       Python 后端（timedatectl 封装）
src/index.tsx 前端 UI（@decky/ui）
dist/         前端构建产物（rollup）
deploy.sh     构建部署脚本
```
