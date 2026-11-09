# PoFi Hydraulic Scroll

A smooth hydraulic damping scroll script / plugin with speed-adaptive physics, designed to eliminate scrolling stutter and motion sickness.

带来如液压旋钮般丝滑阻尼感的滚动脚本 / 插件。采用速度自适应算法，彻底告别生硬跳动、滚轮卡顿与网页眩晕感。

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
