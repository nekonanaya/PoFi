# PoFi Hydraulic Scroll

A smooth hydraulic damping scroll script / plugin with speed-adaptive physics, designed to eliminate scrolling stutter and motion sickness.

带来如液压旋钮般丝滑阻尼感的滚动脚本 / 插件。采用速度自适应算法，彻底告别生硬跳动、滚轮卡顿与网页眩晕感。


### 🎬 Browser | 浏览器

**Before | Native Scrolling**

[Crema3.webm](https://github.com/user-attachments/assets/4ef8efbd-04ae-4aef-b7c1-fcad2d85e8e3)

**After | Po-Fi Hydraulic Scroll**

[Crema2.webm](https://github.com/user-attachments/assets/2a2b5060-9156-4aae-88b1-da2ab8fad4e5)

——————————

## 🎬 Po-Fi Hydraulic Scroll | Before & After

展示原生滚动与 Po-Fi 液压阻尼滚动的实际效果对比。

### Before | Native Scrolling

[Crema1.webm](https://github.com/user-attachments/assets/a528651e-a232-4e59-9718-78a769ba8ac9)


### After | Po-Fi Hydraulic Scroll

[Crema.webm](https://github.com/user-attachments/assets/ec2c6a7f-606d-4f27-96dd-6da2a1e0aaf7)

## Installation / 安装方式

- **Browser Userscript (浏览器油猴脚本)**: 
  [Install via GitHub Raw](https://raw.githubusercontent.com/nekonanaya/PoFi/main/po-fi-scroll.user.js) / [Install via jsDelivr](https://fastly.jsdelivr.net/gh/nekonanaya/PoFi@main/po-fi-scroll.user.js)
- **BetterNCM Plugin (网易云插件版)**: 
  Download the `.plugin` file from the [Releases](https://github.com/nekonanaya/PoFi/releases) page and drop it into your BetterNCM plugins folder.

---

## Troubleshooting / 战地排雷指南

### BetterNCM Hook Cache Reset (底层物理重置)
If you encounter unexpected visual glitches, hook conflicts, or partial theme UI failures after installation:  
如果在安装后遇到偶发性视觉异常、与主题冲突或部分界面未生效：

1. **Clear Hijack Cache (清除缓存)**: Go to BetterNCM Settings and clear the Hijack cache.  
   *(进入 BetterNCM 设置，点击清除 Hijack 缓存。)*
2. **Remove Plugin (移出插件)**: Move `PoFi-Hydraulic-Scroll.plugin` out of your `plugins` directory.  
   *(将本插件移出 `plugins` 文件夹。)*
3. **Restart NCM (首次重启)**: Restart NetEase Cloud Music completely.  
   *(彻底重启一次网易云音乐，使宿主环境归零。)*
4. **Restore Plugin (放回插件)**: Place the `.plugin` file back into the `plugins` directory.  
   *(重新将本插件放入 `plugins` 文件夹。)*
5. **Final Restart (再次重启)**: Restart NCM one more time to cleanly re-anchor all hooks.  
   *(再次重启网易云，完成纯净的物理 Hook 重新挂载。)*
   
---

## Maintenance Status / 维护声明

**Status: Unmaintained / As-Is Release**  
**状态：不提供维护 / 按现状发布**

The BetterNCM edition of Po-Fi Hydraulic Scroll is a personal adaptation, developed and tested for the author's own NetEase Cloud Music environment.  
本 BetterNCM 版的 Po-Fi 液压阻尼滚动是一个极端个人向的适配版本，仅针对作者本人的网易云音乐环境进行过开发与测试。

This release is provided as-is, without any commitment to ongoing maintenance, compatibility updates, bug fixes, or user support.  
本发布按现状（As-Is）提供，不承诺任何后续的持续维护、兼容性更新、Bug 修复或用户支持。

- **Tested ONLY on NetEase Cloud Music v2.10.13.** Compatibility with other NCM versions, BetterNCM versions, themes, and third-party plugins is neither tested nor guaranteed.  
  （**仅在网易云音乐 v2.10.13 版本进行过测试。**不保证与其他网易云版本、BetterNCM 版本、主题及第三方插件的兼容性，也未做过相关测试。）
- No automatic updates or compatibility guarantees are provided.  
  （不提供自动更新或兼容性担保。）
- Issues and feedback are welcome, but responses or fixes are not guaranteed.  
  （欢迎提交 Issue 与反馈，但不保证会进行回复或修复。）
- Users are responsible for evaluating compatibility and backing up their configuration before installation.  
  （用户需自行评估兼容性，并在安装前自行备份配置。）

The browser userscript and BetterNCM extension are maintained as separate adaptations. The maintenance status of one does not imply maintenance of the other.  
（浏览器油猴脚本与 BetterNCM 插件作为独立适配分开维护。其中一方的维护状态不代表另一方也会同步维护。）

**This is a snapshot of a working personal configuration, shared for reference and optional use.**  
**这是作者个人可用配置的一个快照，仅供参考与自愿使用。**



---

## 🎚️ PoFi Pause Fade (`v0.5.2`) — BetterNCM Plugin

> **Acoustic Cubic-Bezier Pause Fade-Out & Resume Fade-In for NetEase Cloud Music.**  
> **网易云音乐暂停淡出 / 恢复淡入插件（声学贝塞尔 S 曲线 + BetterNCM 可视化调音面板）。**

[Crema3.webm](https://github.com/user-attachments/assets/63bd3f75-9161-427e-ad1e-d96fa64e3f1e)

### ✨ Features / 核心特性

- **Zero Audio-Chain Pollution / 零音频链污染**  
  Modulates the client's native volume IPC directly without injecting extra Web Audio (`AudioContext` / `<audio>`) pipelines—leaving your **WASAPI / Equalizer APO / VST3** signal path completely pure and untouched.  
  直接通过客户端原生音量 IPC 实现平滑包络，**绝不插入额外的 Web Audio / `<audio>` 管线**，不污染你原有的 **WASAPI / Equalizer APO / VST3** 纯净音频链路。

- **Acoustic Cubic-Bezier S-Curve / 声学三次贝塞尔 S 曲线**  
  Uses asymmetric, psychoacoustic-friendly cubic-bezier curves by default (zero-jerk departure & landing) with built-in **Sine S-Curve**, **Adjustable Power**, and **Linear** modes for A/B comparison.  
  默认采用针对人耳对数响度优化的**不对称三次贝塞尔 S 曲线**（首尾零顿挫），同时面板内置正弦 S 曲线、可调幂次及纯线性模式供 A/B 对比。

- **Background Throttling Mitigation / 抗后台节流心跳**  
  Driven by a dedicated **Web Worker** timer (with automatic `requestAnimationFrame` failover & watchdog), preventing Chromium from clamping fades to 1-second freezes when the window is minimized or occluded (e.g., controlling via `Fn` media keys).  
  内置独立 **Web Worker** 节拍器（含 `rAF` 故障无缝接管与看门狗兜底），避免客户端最小化或被遮挡后（如使用 `Fn` 媒体键后台切暂停）被 Chromium 节流卡顿。

- **Built-in BetterNCM Config UI / BetterNCM 原生参数面板**  
  Adjust **Fade Out / Fade In (`0 ~ 5000 ms`)**, curve type, anti-pop resume delay, quick presets, and debug logging live without restarting the client.  
  在 BetterNCM 插件设置页内即可实时调节 **淡出/淡入时长（0～5000 ms）**、曲线类型、起播防爆音延迟与快捷预设，**实时生效无需重启**。

---

### 📦 Installation & First-Time Setup / 安装与首次激活

1. Download **`PoFi-Pause-Fade.plugin`** from the [Releases](https://github.com/nekonanaya/PoFi/releases) page (or place the `BetterNCM-PauseFade` folder into your BetterNCM `plugins_dev` directory).  
   前往 [Releases](https://github.com/nekonanaya/PoFi/releases) 页面下载 **`PoFi-Pause-Fade.plugin`** 拖入安装（或将 `BetterNCM-PauseFade` 文件夹放入 `plugins_dev` 目录）。
2. **First Run Tip / 首次激活提示**：While playing music, **drag the NetEase Cloud Music volume slider once** so the plugin automatically locks onto your client's volume IPC signature (subsequent startups restore the signature automatically).  
   首次安装后在播放音乐时，**先手动拖动一次网易云音量条**即可自动锁定音量通道签名（之后重启会自动预热）。

---

### ⚠️ Notes & Compatibility / 使用边界与兼容性说明

- **WASAPI Shared vs. Exclusive / 关于 WASAPI 共享与独占模式**：  
  Works wherever NetEase Cloud Music's built-in volume slider actually attenuates audio (e.g., **WASAPI Shared Mode** or non-locked pipelines). True bit-perfect **WASAPI Exclusive Mode** that completely bypasses/locks the client's software volume cannot be attenuated from frontend JS.  
  只要网易云自带的音量滑块能正常调节响度（如 **WASAPI 共享模式**）即可生效；若处于完全绕过软件增益的硬直通独占模式，前端 JS 无法直接衰减底层 PCM 缓冲。
- **Stop Key & Mute Behavior / 关于停止键与静音态**：  
  Global **Stop** commands remain hard-cut to avoid interfering with internal track switching; if you manually **Mute (`0`)** the player, clicking Play keeps it muted until you unmute (hearing protection by design).  
  「停止键」保持原生硬切以免误伤切歌逻辑；若你主动点了「静音」，恢复播放时也会维持静音直到你取消静音（护耳防炸设计）。
- **Tested Environment & Maintenance Status / 测试环境与维护声明**：  
  Tested **ONLY** on **NetEase Cloud Music `v2.10.13`**. Provided **As-Is** as a personal Po-Fi utility snapshot—if you run into issues on other client versions, feel free to fork or adapt it freely.  
  仅在 **网易云音乐 `v2.10.13`** 上完成实机测试，按 **As-Is** 现状开源分享，欢迎按需自行 Fork 魔改～
