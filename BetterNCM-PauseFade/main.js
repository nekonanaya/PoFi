(() => {
    "use strict";

    // 若存在旧实例（如插件热重载），先彻底清理收敛
    if (typeof window.__pauseFadeCleanup === "function") {
        try { window.__pauseFadeCleanup(); } catch (_) {}
    }

    // ================== 默认配置与持久化 ==================
    const PLUGIN_VERSION = "0.5.2";
    const CONFIG_STORAGE_KEY = "ncm_pause_fade_config_v1";
    const STATE_STORAGE_KEY = "ncm_pause_fade_state_v2";
    const USER_VOLUME_GESTURE_WINDOW_MS = 1200;

    const DEFAULT_CONFIG = {
        enabled: true,
        fadeOutMs: 300,       // 淡出时长 (0~5000 ms)
        fadeInMs: 350,        // 淡入时长 (0~5000 ms)
        curveMode: "bezier",  // "bezier" | "cos" | "power" | "linear"
        curvePower: 2.2,      // 仅 curveMode === "power" 时生效 (1.0~3.5)
        resumeDelayMs: 18,    // 恢复播放后微延迟 (0~100 ms)
        debug: false
    };

    const VALID_CURVES = new Set(["bezier", "cos", "power", "linear"]);

    function clampNum(val, min, max, fallback) {
        const n = Number(val);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(max, n));
    }

    function loadUserConfig() {
        try {
            const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
            if (!raw) return { ...DEFAULT_CONFIG };
            const parsed = JSON.parse(raw);
            return {
                enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_CONFIG.enabled,
                fadeOutMs: clampNum(parsed.fadeOutMs, 0, 5000, DEFAULT_CONFIG.fadeOutMs),
                fadeInMs: clampNum(parsed.fadeInMs, 0, 5000, DEFAULT_CONFIG.fadeInMs),
                curveMode: VALID_CURVES.has(parsed.curveMode) ? parsed.curveMode : DEFAULT_CONFIG.curveMode,
                curvePower: clampNum(parsed.curvePower, 1.0, 3.5, DEFAULT_CONFIG.curvePower),
                resumeDelayMs: clampNum(parsed.resumeDelayMs, 0, 100, DEFAULT_CONFIG.resumeDelayMs),
                debug: typeof parsed.debug === "boolean" ? parsed.debug : DEFAULT_CONFIG.debug
            };
        } catch (_) {
            return { ...DEFAULT_CONFIG };
        }
    }

    function saveUserConfig() {
        try {
            localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(CONFIG));
        } catch (_) {}
    }

    const CONFIG = loadUserConfig();
    const log = (...args) => CONFIG.debug && console.log(`[PauseFade v${PLUGIN_VERSION}]`, ...args);

    // ================== 曲线数学引擎 ==================
    // 标准 1D 三次贝塞尔求解（Newton-Raphson + 二分法保底）
    function evalCubicBezier(x1, y1, x2, y2, t) {
        if (t <= 0) return 0;
        if (t >= 1) return 1;

        const ax = 1 - 3 * x2 + 3 * x1;
        const bx = 3 * x2 - 6 * x1;
        const cx = 3 * x1;

        const sampleX = (u) => ((ax * u + bx) * u + cx) * u;
        const sampleSlopeX = (u) => (3 * ax * u + 2 * bx) * u + cx;
        const sampleY = (u) => (((1 - 3 * y2 + 3 * y1) * u + (3 * y2 - 6 * y1)) * u + 3 * y1) * u;

        let lo = 0;
        let hi = 1;
        let u = t;

        for (let i = 0; i < 6; i++) {
            const x = sampleX(u);
            const err = x - t;
            if (Math.abs(err) < 1e-5) return sampleY(u);
            if (x < t) lo = u;
            else hi = u;

            const dx = sampleSlopeX(u);
            if (Math.abs(dx) < 1e-5) break;
            const nextU = u - err / dx;
            if (nextU <= lo || nextU >= hi) break;
            u = nextU;
        }

        for (let i = 0; i < 12; i++) {
            const x = sampleX(u);
            if (Math.abs(x - t) < 1e-5) break;
            if (x < t) lo = u;
            else hi = u;
            u = 0.5 * (lo + hi);
        }

        return sampleY(u);
    }

    function computeCurveProgress(t, isFadeOut) {
        switch (CONFIG.curveMode) {
            case "bezier":
                // 淡出：缓离满音 -> 对数下潜 -> 长柔尾音归零
                // 淡入：精确镜像（零斜率浮现 -> 柔缓落定）
                return isFadeOut
                    ? evalCubicBezier(0.30, 0.05, 0.25, 1.00, t)
                    : evalCubicBezier(0.75, 0.00, 0.70, 0.95, t);
            case "cos":
                return 0.5 - 0.5 * Math.cos(Math.PI * t);
            case "linear":
                return t;
            case "power":
            default:
                return isFadeOut
                    ? 1 - Math.pow(1 - t, CONFIG.curvePower)
                    : Math.pow(t, CONFIG.curvePower);
        }
    }

    // ================== 状态机与核心变量 ==================
    // fadeState: 'idle' | 'fadingOut' | 'paused' | 'fadingIn'
    let fadeState = "idle";
    let userTargetVolume = null;
    let actualAnimatedVolume = null; // null 表示尚未观测/提交真实播放器音量
    let pendingAction = null;        // { type: "pause", args: any[] } | null
    let fadeToken = 0;

    const ipcProfile = {
        volSignature: null
    };

    let rawChannelCall = null;
    let rawRegisterCall = null;
    let bootTimer = 0;
    let bootRestoreTimer = 0;
    let bootRestoreData = null;
    let bootRestorePending = false;
    let bootUserInteracted = false;
    let lastUserVolumeGestureAt = -Infinity;

    let tickerWorker = null;
    let workerBlobUrl = null;
    let workerReady = false;

    let activeCancel = null;
    let activeWorkerTick = null;
    let activeWorkerFailover = null;
    let panelStatusUpdater = null;

    function refreshPanelStatus() {
        if (typeof panelStatusUpdater === "function") {
            try { panelStatusUpdater(); } catch (_) {}
        }
    }

    // ================== 工具：安全构造与序列化 IPC 参数 ==================
    function cloneJsonSafe(val) {
        if (val === null || val === undefined) return val;
        if (typeof val === "number" || typeof val === "string" || typeof val === "boolean") return val;
        try { return JSON.parse(JSON.stringify(val)); } catch (_) { return null; }
    }

    function buildArgsPattern(args) {
        return args.map((item) => {
            if (typeof item === "function") return { __pfType: "fn" };
            return cloneJsonSafe(item);
        });
    }

    function materializeArgs(sig, volumeValue) {
        const scaled = sig.scale === 100
            ? Math.round(Math.max(0, Math.min(100, volumeValue)))
            : Math.max(0, Math.min(1, volumeValue));

        const out = sig.pattern.map((item) => {
            if (item && typeof item === "object" && item.__pfType === "fn") {
                return () => {};
            }
            return cloneJsonSafe(item);
        });

        if (sig.innerIndex !== null && Array.isArray(out[sig.argIndex])) {
            out[sig.argIndex][sig.innerIndex] = scaled;
        } else {
            out[sig.argIndex] = scaled;
        }
        return out;
    }

    function inspectVolumeCall(cmd, fullArgs) {
        if (!/volume/i.test(cmd) || /get|mute|device|eq|info|list/i.test(cmd)) {
            return null;
        }

        let foundArgIdx = -1;
        let foundInnerIdx = null;
        let rawVal = null;

        for (let i = 1; i < fullArgs.length; i++) {
            const arg = fullArgs[i];
            if (typeof arg === "number" && Number.isFinite(arg) && arg >= 0 && arg <= 100) {
                foundArgIdx = i;
                foundInnerIdx = null;
                rawVal = arg;
                break;
            }
            if (Array.isArray(arg)) {
                for (let j = arg.length - 1; j >= 0; j--) {
                    const elem = arg[j];
                    if (typeof elem === "number" && Number.isFinite(elem) && elem >= 0 && elem <= 100) {
                        foundArgIdx = i;
                        foundInnerIdx = j;
                        rawVal = elem;
                        break;
                    }
                }
                if (foundArgIdx !== -1) break;
            }
        }

        if (foundArgIdx === -1) return null;

        const prevSig = ipcProfile.volSignature;
        let scale = prevSig ? prevSig.scale : 1;
        let scaleLocked = prevSig ? prevSig.scaleLocked : false;

        // PATCH 5：一旦锁定标度就不再被后续数值覆盖
        if (!scaleLocked) {
            if (rawVal > 1) {
                scale = 100;
                scaleLocked = true;
            } else if (rawVal > 0 && rawVal < 1) {
                scale = 1;
                scaleLocked = true;
            }
        }

        return {
            vol: rawVal,
            sig: {
                cmd,
                scale,
                scaleLocked,
                argIndex: foundArgIdx,
                innerIndex: foundInnerIdx,
                pattern: buildArgsPattern(fullArgs)
            }
        };
    }

    // PATCH 3：成功提交后再更新 actualAnimatedVolume
    function callNativeVolume(val) {
        if (!rawChannelCall || !ipcProfile.volSignature) return false;
        const sig = ipcProfile.volSignature;
        const clamped = Math.max(0, Math.min(sig.scale, val));
        try {
            const args = materializeArgs(sig, clamped);
            rawChannelCall.apply(window.channel, args);
            actualAnimatedVolume = clamped;
            return true;
        } catch (e) {
            log("原生音量调用异常:", e);
            return false;
        }
    }

    // PATCH 1：零音量或零时长直通时也同步更新状态机
    function forwardPlaybackCommand(type, context, args) {
        const ret = rawChannelCall.apply(context, args);
        pendingAction = null;
        fadeState = type === "pause" ? "paused" : "idle";
        return ret;
    }

    // ================== 持久化、用户手势识别与开机恢复 ==================
    function saveVolumeState(vol, sig, dirtyMuted = fadeState !== "idle") {
        if (typeof vol !== "number" || !Number.isFinite(vol) || !sig) return;
        try {
            localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify({
                vol,
                sig,
                dirtyMuted: Boolean(dirtyMuted),
                ts: Date.now()
            }));
        } catch (_) {}
    }

    function eventTargetsVolumeControl(event) {
        const path = typeof event.composedPath === "function"
            ? event.composedPath()
            : [event.target];

        return path.some((node) => {
            if (typeof Element === "undefined" || !(node instanceof Element)) return false;

            if (node.matches('input[type="range"], [role="slider"], .m-vol, .m-vol .prg, .u-vol, .u-vol .prg, .j-vol, .j-vol .prg')) {
                return true;
            }

            const meta = [
                node.id,
                node.getAttribute("aria-label") || "",
                node.getAttribute("title") || "",
                node.getAttribute("data-testid") || "",
                typeof node.className === "string" ? node.className : ""
            ].join(" ");

            return /\b(volume|vol)\b/i.test(meta);
        });
    }

    function onPotentialVolumeGesture(event) {
        if (!event.isTrusted) return;
        const volumeKeys = ["AudioVolumeUp", "AudioVolumeDown", "VolumeUp", "VolumeDown"];
        const isVolumeKey = event.type === "keydown" && volumeKeys.includes(String(event.key || ""));
        if (!isVolumeKey && !eventTargetsVolumeControl(event)) return;
        lastUserVolumeGestureAt = performance.now();
    }

    function hasRecentUserVolumeGesture() {
        return performance.now() - lastUserVolumeGestureAt <= USER_VOLUME_GESTURE_WINDOW_MS;
    }

    function markBootInteracted() {
        bootUserInteracted = true;
        bootRestorePending = false;
        if (bootRestoreTimer) {
            clearTimeout(bootRestoreTimer);
            bootRestoreTimer = 0;
        }
    }

    function flushBootRestoreBeforePlaybackCommand() {
        if (!bootRestorePending || !bootRestoreData) return true;

        if (bootRestoreTimer) {
            clearTimeout(bootRestoreTimer);
            bootRestoreTimer = 0;
        }
        if (bootUserInteracted) {
            bootRestorePending = false;
            return true;
        }

        const ok = callNativeVolume(bootRestoreData.vol);
        if (ok) {
            bootRestorePending = false;
            saveVolumeState(bootRestoreData.vol, ipcProfile.volSignature, false);
        }
        return ok;
    }

    function scheduleBootRestore() {
        try {
            const raw = localStorage.getItem(STATE_STORAGE_KEY);
            if (!raw) return;
            const data = JSON.parse(raw);

            if (
                !data ||
                typeof data.vol !== "number" ||
                !Number.isFinite(data.vol) ||
                data.vol < 0 ||
                !data.sig ||
                !data.sig.cmd
            ) {
                return;
            }

            if (!ipcProfile.volSignature) {
                ipcProfile.volSignature = data.sig;
                refreshPanelStatus();
            }

            userTargetVolume = data.vol;
            actualAnimatedVolume = null; // 真实播放器音量尚未确认

            // 显式要求 dirtyMuted === true，兼容不含该字段的旧版 v2 存档
            const dirtyMuted = data.dirtyMuted === true;
            if (!dirtyMuted) {
                bootRestorePending = false;
                return;
            }

            bootRestoreData = data;
            bootRestorePending = true;
            bootUserInteracted = false;

            bootRestoreTimer = setTimeout(() => {
                bootRestoreTimer = 0;
                if (!bootRestorePending || bootUserInteracted || fadeState !== "idle" || !rawChannelCall) {
                    return;
                }
                log("检测到上次会话在淡出/暂停静音态退出，恢复目标音量:", data.vol);
                if (callNativeVolume(data.vol)) {
                    bootRestorePending = false;
                    saveVolumeState(data.vol, ipcProfile.volSignature, false);
                }
            }, 1500);
        } catch (e) {
            log("启动音量恢复失败:", e);
        }
    }

    // ================== Web Worker 独立计时通道 ==================
    function revokeWorkerBlob() {
        if (workerBlobUrl) {
            try { URL.revokeObjectURL(workerBlobUrl); } catch (_) {}
            workerBlobUrl = null;
        }
    }

    function destroyWorker() {
        if (tickerWorker) {
            try { tickerWorker.postMessage({ type: "stop" }); } catch (_) {}
            try { tickerWorker.terminate(); } catch (_) {}
            tickerWorker = null;
        }
        workerReady = false;
        revokeWorkerBlob();
        refreshPanelStatus();
    }

    function initWorkerTicker() {
        const workerCode = `
            let timer = 0;
            self.onmessage = (e) => {
                const msg = e.data || {};
                if (msg.type === "ping") {
                    self.postMessage("pong");
                } else if (msg.type === "start") {
                    if (timer) clearInterval(timer);
                    timer = setInterval(() => self.postMessage("tick"), msg.interval || 16);
                } else if (msg.type === "stop") {
                    if (timer) { clearInterval(timer); timer = 0; }
                }
            };
        `;

        const attach = (w) => {
            w.onmessage = (e) => {
                if (e.data === "pong") {
                    workerReady = true;
                    revokeWorkerBlob();
                    refreshPanelStatus();
                    log("Worker 心跳握手完成（用于降低后台计时节流影响）");
                } else if (e.data === "tick" && activeWorkerTick) {
                    activeWorkerTick(performance.now());
                }
            };
            w.onerror = (err) => {
                log("Worker 异常，切换至 rAF 兜底:", err);
                destroyWorker();
                if (activeWorkerFailover) activeWorkerFailover();
            };
            w.postMessage({ type: "ping" });
            return w;
        };

        try {
            const blob = new Blob([workerCode], { type: "application/javascript" });
            workerBlobUrl = URL.createObjectURL(blob);
            tickerWorker = attach(new Worker(workerBlobUrl));
        } catch (_) {
            revokeWorkerBlob();
            try {
                tickerWorker = attach(new Worker("data:application/javascript," + encodeURIComponent(workerCode)));
            } catch (__) {
                tickerWorker = null;
                workerReady = false;
            }
        }
    }

    // ================== 动画引擎 ==================
    function stopCurrentAnimation() {
        fadeToken++;
        if (activeCancel) {
            const cancelFn = activeCancel;
            activeCancel = null;
            cancelFn();
        }
        activeWorkerTick = null;
        activeWorkerFailover = null;
        if (tickerWorker && workerReady) {
            try { tickerWorker.postMessage({ type: "stop" }); } catch (_) {}
        }
    }

    function animateVolume(fromVol, toVol, durationMs, onDone, delayMs = 0) {
        stopCurrentAnimation();

        const myToken = fadeToken;
        let driver = (tickerWorker && workerReady) ? "worker" : "raf";
        let rafId = 0;
        let delayTimer = 0;
        let watchdogTimer = 0;
        let settled = false;

        const cleanupTimers = () => {
            cancelAnimationFrame(rafId);
            clearTimeout(delayTimer);
            clearTimeout(watchdogTimer);
            activeWorkerTick = null;
            activeWorkerFailover = null;
            if (tickerWorker && workerReady) {
                try { tickerWorker.postMessage({ type: "stop" }); } catch (_) {}
            }
        };

        const finish = (completed, reason = completed ? "completed" : "cancelled") => {
            if (settled) return;
            settled = true;
            activeCancel = null;
            cleanupTimers();
            onDone && onDone(completed, reason);
        };

        activeCancel = () => finish(false, "cancelled");

        const setVolumeOrFail = (value) => {
            if (callNativeVolume(value)) return true;
            finish(false, "volume-ipc-failed");
            return false;
        };

        if (driver === "raf" && document.hidden) {
            if (setVolumeOrFail(toVol)) finish(true);
            return;
        }

        const startTime = performance.now() + delayMs;
        const isFadeOut = toVol < fromVol;

        const watchdogMs = Math.max(800, delayMs + durationMs + 600);
        watchdogTimer = setTimeout(() => {
            if (settled || myToken !== fadeToken) return;
            log("动画看门狗兜底完成 ->", toVol);
            if (setVolumeOrFail(toVol)) finish(true);
        }, watchdogMs);

        const step = (now) => {
            if (settled || myToken !== fadeToken) return;

            if (now < startTime) {
                if (driver === "raf") rafId = requestAnimationFrame(step);
                return;
            }

            if (durationMs <= 0 || Math.abs(fromVol - toVol) < 1e-4) {
                if (setVolumeOrFail(toVol)) finish(true);
                return;
            }

            const t = Math.min(1, (now - startTime) / durationMs);
            const ratio = computeCurveProgress(t, isFadeOut);
            const v = t >= 1 ? toVol : fromVol + (toVol - fromVol) * ratio;

            if (!setVolumeOrFail(v)) return;

            if (t < 1) {
                if (driver === "raf") rafId = requestAnimationFrame(step);
            } else {
                finish(true);
            }
        };

        activeWorkerFailover = () => {
            if (settled || myToken !== fadeToken || driver !== "worker") return;
            driver = "raf";
            rafId = requestAnimationFrame(step);
        };

        if (driver === "worker") {
            activeWorkerTick = step;
            try {
                tickerWorker.postMessage({ type: "start", interval: 16 });
            } catch (_) {
                activeWorkerFailover();
            }
        } else {
            if (delayMs > 0) {
                delayTimer = setTimeout(() => {
                    if (!settled && myToken === fadeToken) {
                        rafId = requestAnimationFrame(step);
                    }
                }, delayMs);
            } else {
                rafId = requestAnimationFrame(step);
            }
        }
    }

    // ================== BetterNCM 设置面板 UI ==================
    function createConfigPanel() {
        const root = document.createElement("div");
        root.style.cssText = [
            "padding: 16px;",
            "display: flex;",
            "flex-direction: column;",
            "gap: 14px;",
            "font-size: 13px;",
            "line-height: 1.5;",
            "color: inherit;",
            "max-width: 560px;"
        ].join("");

        const cardStyle = [
            "padding: 12px 14px;",
            "border-radius: 10px;",
            "background: rgba(128, 128, 128, 0.10);",
            "border: 1px solid rgba(128, 128, 128, 0.18);",
            "display: flex;",
            "flex-direction: column;",
            "gap: 10px;"
        ].join("");

        const btnStyle = [
            "padding: 4px 10px;",
            "border-radius: 6px;",
            "border: 1px solid rgba(128, 128, 128, 0.3);",
            "background: rgba(128, 128, 128, 0.14);",
            "color: inherit;",
            "cursor: pointer;",
            "font-size: 12px;"
        ].join("");

        const inputNumStyle = [
            "width: 70px;",
            "padding: 3px 6px;",
            "border-radius: 6px;",
            "border: 1px solid rgba(128, 128, 128, 0.32);",
            "background: rgba(128, 128, 128, 0.12);",
            "color: inherit;",
            "text-align: right;",
            "font-size: 12px;"
        ].join("");

        const selectStyle = [
            "padding: 4px 8px;",
            "border-radius: 6px;",
            "border: 1px solid rgba(128, 128, 128, 0.32);",
            "background: rgba(128, 128, 128, 0.14);",
            "color: inherit;",
            "font-size: 12px;",
            "cursor: pointer;"
        ].join("");

        const headCard = document.createElement("div");
        headCard.style.cssText = cardStyle;

        const makeCheckbox = (labelText, hintText, checked, onChange) => {
            const row = document.createElement("label");
            row.style.cssText = "display:flex; align-items:flex-start; gap:8px; cursor:pointer; user-select:none;";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = checked;
            cb.style.cssText = "margin-top:3px; cursor:pointer;";
            cb.addEventListener("change", () => onChange(cb.checked));

            const txt = document.createElement("div");
            const main = document.createElement("div");
            main.textContent = labelText;
            main.style.fontWeight = "600";
            txt.appendChild(main);
            if (hintText) {
                const sub = document.createElement("div");
                sub.textContent = hintText;
                sub.style.cssText = "font-size:11px; opacity:0.72;";
                txt.appendChild(sub);
            }
            row.appendChild(cb);
            row.appendChild(txt);
            return { row, cb };
        };

        const enabledCtrl = makeCheckbox(
            `启用暂停淡出 / 恢复淡入 (v${PLUGIN_VERSION})`,
            "关闭后将立即透传原生播放控制，不卸载插件即可随时切换",
            CONFIG.enabled,
            (val) => {
                CONFIG.enabled = val;
                saveUserConfig();
                if (!val && fadeState !== "idle") {
                    pendingAction = null;
                    stopCurrentAnimation();
                    fadeState = "idle";
                    if (userTargetVolume !== null) {
                        callNativeVolume(userTargetVolume);
                        saveVolumeState(userTargetVolume, ipcProfile.volSignature, false);
                    }
                }
            }
        );

        const debugCtrl = makeCheckbox(
            "调试日志（F12 Console 输出 IPC 详情）",
            "想排查「停止键」等外部按键是否经过前端 IPC 时打开即可",
            CONFIG.debug,
            (val) => {
                CONFIG.debug = val;
                saveUserConfig();
            }
        );

        headCard.appendChild(enabledCtrl.row);
        headCard.appendChild(debugCtrl.row);
        root.appendChild(headCard);

        const sliderRefs = {};
        const makeSliderRow = ({ key, title, unit, min, max, step, hint, isFloat }) => {
            const box = document.createElement("div");
            box.style.cssText = "display:flex; flex-direction:column; gap:5px;";

            const top = document.createElement("div");
            top.style.cssText = "display:flex; justify-content:space-between; align-items:center; gap:8px;";

            const label = document.createElement("span");
            label.textContent = title;
            label.style.fontWeight = "600";

            const right = document.createElement("div");
            right.style.cssText = "display:flex; align-items:center; gap:4px;";

            const numInput = document.createElement("input");
            numInput.type = "number";
            numInput.min = String(min);
            numInput.max = String(max);
            numInput.step = String(step);
            numInput.value = String(CONFIG[key]);
            numInput.style.cssText = inputNumStyle;

            const unitSpan = document.createElement("span");
            unitSpan.textContent = unit;
            unitSpan.style.cssText = "font-size:12px; opacity:0.75; min-width:24px;";

            right.appendChild(numInput);
            right.appendChild(unitSpan);
            top.appendChild(label);
            top.appendChild(right);

            const range = document.createElement("input");
            range.type = "range";
            range.min = String(min);
            range.max = String(max);
            range.step = String(step);
            range.value = String(CONFIG[key]);
            range.style.cssText = "width:100%; cursor:pointer;";

            const applyVal = (raw, syncInput) => {
                const clamped = clampNum(raw, min, max, DEFAULT_CONFIG[key]);
                const normalized = isFloat ? Math.round(clamped * 10) / 10 : Math.round(clamped);
                CONFIG[key] = normalized;
                range.value = String(normalized);
                if (syncInput) numInput.value = String(normalized);
                saveUserConfig();
            };

            range.addEventListener("input", () => applyVal(range.value, true));
            numInput.addEventListener("input", () => {
                const n = Number(numInput.value);
                if (Number.isFinite(n) && n >= min && n <= max) applyVal(n, false);
            });
            numInput.addEventListener("change", () => applyVal(numInput.value, true));

            box.appendChild(top);
            box.appendChild(range);

            if (hint) {
                const hintEl = document.createElement("div");
                hintEl.textContent = hint;
                hintEl.style.cssText = "font-size:11px; opacity:0.68;";
                box.appendChild(hintEl);
            }

            sliderRefs[key] = (val) => applyVal(val, true);
            return { box, range, numInput };
        };

        const paramCard = document.createElement("div");
        paramCard.style.cssText = cardStyle;

        paramCard.appendChild(makeSliderRow({
            key: "fadeOutMs",
            title: "暂停淡出时长 (Fade Out)",
            unit: "ms",
            min: 0,
            max: 5000,
            step: 50,
            hint: "设为 0 表示直接硬切；最长支持 5000ms（5秒）"
        }).box);

        paramCard.appendChild(makeSliderRow({
            key: "fadeInMs",
            title: "恢复淡入时长 (Fade In)",
            unit: "ms",
            min: 0,
            max: 5000,
            step: 50,
            hint: "通常可以比淡出略长一些，柔和拉起声音不吓耳朵"
        }).box);

        // 曲线类型选择器
        const curveRow = document.createElement("div");
        curveRow.style.cssText = "display:flex; flex-direction:column; gap:5px;";
        const curveTop = document.createElement("div");
        curveTop.style.cssText = "display:flex; justify-content:space-between; align-items:center; gap:8px;";
        const curveLabel = document.createElement("span");
        curveLabel.textContent = "包络曲线类型 (Envelope Curve)";
        curveLabel.style.fontWeight = "600";

        const curveSelect = document.createElement("select");
        curveSelect.style.cssText = selectStyle;
        [
            { value: "bezier", text: "声学贝塞尔 S 曲线（推荐）" },
            { value: "cos", text: "对称正弦 S 曲线 (EaseInOutSine)" },
            { value: "power", text: "可调幂次曲线 (Power)" },
            { value: "linear", text: "纯线性 (Linear)" }
        ].forEach((opt) => {
            const o = document.createElement("option");
            o.value = opt.value;
            o.textContent = opt.text;
            curveSelect.appendChild(o);
        });
        curveSelect.value = CONFIG.curveMode;

        const curveHint = document.createElement("div");
        curveHint.style.cssText = "font-size:11px; opacity:0.68;";
        const updateCurveHint = () => {
            const hints = {
                bezier: "首尾零顿挫 + 听感响度补偿，最接近硬件调音台推子",
                cos: "经典对称 S 型曲线，中段平滑过渡",
                power: "单边幂次衰减/抬升，配合下方幂次滑块微调弧度",
                linear: "匀速直线变化，方便做 A/B 盲听对比"
            };
            curveHint.textContent = hints[CONFIG.curveMode] || "";
        };
        updateCurveHint();

        curveTop.appendChild(curveLabel);
        curveTop.appendChild(curveSelect);
        curveRow.appendChild(curveTop);
        curveRow.appendChild(curveHint);
        paramCard.appendChild(curveRow);

        const powerCtrl = makeSliderRow({
            key: "curvePower",
            title: "幂次曲线弧度 (仅 Power 模式生效)",
            unit: "x",
            min: 1.0,
            max: 3.5,
            step: 0.1,
            isFloat: true,
            hint: "1.0 = 线性；2.0~2.5 = 接近人耳对数响度"
        });
        const syncPowerVisibility = () => {
            powerCtrl.box.style.opacity = CONFIG.curveMode === "power" ? "1" : "0.48";
        };
        syncPowerVisibility();

        curveSelect.addEventListener("change", () => {
            CONFIG.curveMode = VALID_CURVES.has(curveSelect.value) ? curveSelect.value : DEFAULT_CONFIG.curveMode;
            saveUserConfig();
            updateCurveHint();
            syncPowerVisibility();
        });

        paramCard.appendChild(powerCtrl.box);

        paramCard.appendChild(makeSliderRow({
            key: "resumeDelayMs",
            title: "恢复起播防爆音延迟",
            unit: "ms",
            min: 0,
            max: 100,
            step: 2,
            hint: "先静音唤醒 WASAPI 缓冲再抬音量，一般保持 16~24ms 即可"
        }).box);

        const presetRow = document.createElement("div");
        presetRow.style.cssText = "display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding-top:4px;";
        const presetLabel = document.createElement("span");
        presetLabel.textContent = "快捷预设：";
        presetLabel.style.cssText = "font-size:12px; opacity:0.8;";
        presetRow.appendChild(presetLabel);

        [
            { name: "轻盈 300/350", out: 300, inn: 350 },
            { name: "丝滑 600/850", out: 600, inn: 850 },
            { name: "落幕 1500/1800", out: 1500, inn: 1800 },
            { name: "剧场 3000/3000", out: 3000, inn: 3000 }
        ].forEach((p) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = p.name;
            b.style.cssText = btnStyle;
            b.addEventListener("click", () => {
                sliderRefs.fadeOutMs(p.out);
                sliderRefs.fadeInMs(p.inn);
            });
            presetRow.appendChild(b);
        });

        const resetBtn = document.createElement("button");
        resetBtn.type = "button";
        resetBtn.textContent = "恢复默认";
        resetBtn.style.cssText = btnStyle + "margin-left:auto;";
        resetBtn.addEventListener("click", () => {
            enabledCtrl.cb.checked = DEFAULT_CONFIG.enabled;
            CONFIG.enabled = DEFAULT_CONFIG.enabled;
            debugCtrl.cb.checked = DEFAULT_CONFIG.debug;
            CONFIG.debug = DEFAULT_CONFIG.debug;
            CONFIG.curveMode = DEFAULT_CONFIG.curveMode;
            curveSelect.value = DEFAULT_CONFIG.curveMode;
            updateCurveHint();
            syncPowerVisibility();
            sliderRefs.fadeOutMs(DEFAULT_CONFIG.fadeOutMs);
            sliderRefs.fadeInMs(DEFAULT_CONFIG.fadeInMs);
            sliderRefs.curvePower(DEFAULT_CONFIG.curvePower);
            sliderRefs.resumeDelayMs(DEFAULT_CONFIG.resumeDelayMs);
            saveUserConfig();
        });
        presetRow.appendChild(resetBtn);

        paramCard.appendChild(presetRow);
        root.appendChild(paramCard);

        const statusCard = document.createElement("div");
        statusCard.style.cssText = cardStyle + "font-size:12px; opacity:0.85;";
        const statusText = document.createElement("div");
        statusCard.appendChild(statusText);
        root.appendChild(statusCard);

        panelStatusUpdater = () => {
            const sigText = ipcProfile.volSignature
                ? `已锁定 (${ipcProfile.volSignature.cmd}，标度 0~${ipcProfile.volSignature.scale})`
                : "未捕获（播放时拖动一次网易云音量条即可自动锁定）";
            const workerText = workerReady ? "Web Worker 60Hz 已就绪" : "rAF 兜底模式";
            statusText.textContent = `音量通道：${sigText} ｜ 计时器：${workerText}`;
        };
        panelStatusUpdater();

        return root;
    }

    function registerPluginConfigUI() {
        const bncmPlugin = (typeof plugin !== "undefined" && plugin)
            || (window.loadedPlugins && window.loadedPlugins["pause-fade"])
            || null;

        if (bncmPlugin && typeof bncmPlugin.onConfig === "function") {
            bncmPlugin.onConfig(() => createConfigPanel());
            log("已注册 BetterNCM 插件配置面板");
            return true;
        }
        return false;
    }

    // ================== IPC 拦截与生命周期 ==================
    function onBeforeUnload() {
        stopCurrentAnimation();
        if (fadeState !== "idle" && userTargetVolume !== null && ipcProfile.volSignature) {
            if (userTargetVolume > 0) {
                callNativeVolume(userTargetVolume);
            }
            saveVolumeState(userTargetVolume, ipcProfile.volSignature, true);
        }
    }

    function hookChannel() {
        if (!window.channel || typeof window.channel.call !== "function") return false;
        if (window.channel.__pauseFadeHooked) return true;

        rawChannelCall = window.channel.call;
        window.channel.__pauseFadeHooked = true;
        initWorkerTicker();

        if (typeof window.channel.registerCall === "function") {
            rawRegisterCall = window.channel.registerCall;
            window.channel.registerCall = function (eventName, cb, ...rest) {
                const wrapped = function (...cbArgs) {
                    if (CONFIG.debug && /audio|player|play|pause|stop|hotkey|media|volume/i.test(String(eventName))) {
                        log("C++ -> JS 回调:", eventName, cbArgs);
                    }
                    return cb && cb.apply(this, cbArgs);
                };
                return rawRegisterCall.call(this, eventName, wrapped, ...rest);
            };
        }

        const gestureEvents = ["pointerdown", "input", "change", "wheel", "keydown"];
        gestureEvents.forEach((type) => {
            document.addEventListener(type, onPotentialVolumeGesture, true);
        });

        window.channel.call = function (...args) {
            const cmd = String(args[0] || "");

            if (CONFIG.debug && /audio|player|volume|play|pause|stop|resume/i.test(cmd)) {
                log("JS -> C++ IPC:", cmd, args.slice(1), {
                    enabled: CONFIG.enabled,
                    fadeState,
                    userTargetVolume,
                    actualAnimatedVolume,
                    pendingAction: pendingAction ? pendingAction.type : null,
                    workerReady
                });
            }

            // 1. 音量 IPC 拦截（PATCH 2）
            const parsedVol = inspectVolumeCall(cmd, args);
            if (parsedVol) {
                const isFirstLock = !ipcProfile.volSignature;

                if (bootRestorePending && hasRecentUserVolumeGesture()) {
                    markBootInteracted();
                }

                // 恢复等待期若非用户主动操作，仅观察真实音量与签名，不覆盖持久化的用户目标音量
                if (bootRestorePending && !bootUserInteracted) {
                    const ret = rawChannelCall.apply(this, args);
                    ipcProfile.volSignature = parsedVol.sig;
                    actualAnimatedVolume = parsedVol.vol;
                    if (isFirstLock) refreshPanelStatus();
                    return ret;
                }

                // 用户主动调节音量：先取消旧动画，执行原生 IPC 后再同步状态
                if (fadeState === "fadingOut" || fadeState === "fadingIn") {
                    pendingAction = null;
                    stopCurrentAnimation();
                    fadeState = "idle";
                }

                const ret = rawChannelCall.apply(this, args);
                ipcProfile.volSignature = parsedVol.sig;
                userTargetVolume = parsedVol.vol;
                actualAnimatedVolume = parsedVol.vol;
                saveVolumeState(userTargetVolume, ipcProfile.volSignature, fadeState !== "idle");
                if (isFirstLock) refreshPanelStatus();
                return ret;
            }

            if (!CONFIG.enabled) {
                return rawChannelCall.apply(this, args);
            }

            // 2. 拦截暂停（PATCH 1 + PATCH 2 + PATCH 3）
            if (/\bpause\b/i.test(cmd) && /audio|player/i.test(cmd)) {
                if (!flushBootRestoreBeforePlaybackCommand()) {
                    return forwardPlaybackCommand("pause", this, args);
                }

                if (!ipcProfile.volSignature || userTargetVolume === null || userTargetVolume <= 0 || CONFIG.fadeOutMs <= 0) {
                    return forwardPlaybackCommand("pause", this, args);
                }
                if (fadeState === "fadingOut") return;
                if (fadeState === "paused") return forwardPlaybackCommand("pause", this, args);

                const startVol = actualAnimatedVolume !== null ? actualAnimatedVolume : userTargetVolume;
                const proportionalMs = userTargetVolume > 0
                    ? CONFIG.fadeOutMs * Math.max(0.1, Math.min(1, startVol / userTargetVolume))
                    : CONFIG.fadeOutMs;

                fadeState = "fadingOut";
                pendingAction = { type: "pause", args };
                saveVolumeState(userTargetVolume, ipcProfile.volSignature, true);

                animateVolume(startVol, 0, proportionalMs, (completed, reason) => {
                    if (!completed) {
                        if (reason !== "cancelled" && fadeState === "fadingOut") {
                            pendingAction = null;
                            fadeState = "idle";
                        }
                        return;
                    }

                    const action = pendingAction;
                    pendingAction = null;

                    try {
                        fadeState = "paused";
                        if (action && action.type === "pause") {
                            rawChannelCall.apply(window.channel, action.args);
                        }
                    } catch (err) {
                        log("原生暂停执行异常，回滚状态:", err);
                        fadeState = "idle";
                        if (userTargetVolume !== null) {
                            callNativeVolume(userTargetVolume);
                            saveVolumeState(userTargetVolume, ipcProfile.volSignature, false);
                        }
                    }
                });
                return;
            }

            // 3. 拦截播放/恢复（PATCH 1 + PATCH 2 + PATCH 3）
            if (/\b(play|resume)\b/i.test(cmd) && /audio|player/i.test(cmd)) {
                if (!flushBootRestoreBeforePlaybackCommand()) {
                    return forwardPlaybackCommand("play", this, args);
                }

                if (!ipcProfile.volSignature || userTargetVolume === null || userTargetVolume <= 0) {
                    return forwardPlaybackCommand("play", this, args);
                }

                if (fadeState === "fadingOut") {
                    pendingAction = null;
                    fadeState = "fadingIn";
                    const target = userTargetVolume;
                    const startVol = actualAnimatedVolume !== null ? actualAnimatedVolume : 0;
                    const remainRatio = Math.max(0.1, Math.min(1, 1 - startVol / target));

                    animateVolume(startVol, target, CONFIG.fadeInMs * remainRatio, (completed, reason) => {
                        if (completed) {
                            fadeState = "idle";
                            saveVolumeState(userTargetVolume, ipcProfile.volSignature, false);
                        } else if (reason !== "cancelled" && fadeState === "fadingIn") {
                            fadeState = "idle";
                        }
                    });
                    return;
                }

                if (fadeState === "paused") {
                    pendingAction = null;

                    if (CONFIG.fadeInMs <= 0) {
                        callNativeVolume(userTargetVolume);
                        saveVolumeState(userTargetVolume, ipcProfile.volSignature, false);
                        return forwardPlaybackCommand("play", this, args);
                    }

                    if (!callNativeVolume(0)) {
                        log("起播静音提交失败，降级直通原生播放");
                        return forwardPlaybackCommand("play", this, args);
                    }

                    fadeState = "fadingIn";
                    const target = userTargetVolume;

                    let ret;
                    try {
                        ret = rawChannelCall.apply(this, args);
                    } catch (err) {
                        log("原生恢复播放异常，回滚状态:", err);
                        fadeState = "paused";
                        callNativeVolume(target);
                        throw err;
                    }

                    animateVolume(0, target, CONFIG.fadeInMs, (completed, reason) => {
                        if (completed) {
                            fadeState = "idle";
                            saveVolumeState(userTargetVolume, ipcProfile.volSignature, false);
                        } else if (reason !== "cancelled" && fadeState === "fadingIn") {
                            fadeState = "idle";
                        }
                    }, CONFIG.resumeDelayMs);
                    return ret;
                }
            }

            return rawChannelCall.apply(this, args);
        };

        window.addEventListener("beforeunload", onBeforeUnload);
        scheduleBootRestore();

        // PATCH 4：热重载卸载时完成状态收敛并彻底清理监听器
        window.__pauseFadeCleanup = () => {
            clearInterval(bootTimer);
            clearTimeout(bootRestoreTimer);

            const oldState = fadeState;
            const oldAction = pendingAction;
            pendingAction = null;

            stopCurrentAnimation();

            if (oldState === "fadingOut" && oldAction && oldAction.type === "pause") {
                callNativeVolume(0);
                try {
                    rawChannelCall.apply(window.channel, oldAction.args);
                    fadeState = "paused";
                    if (userTargetVolume !== null && ipcProfile.volSignature) {
                        saveVolumeState(userTargetVolume, ipcProfile.volSignature, true);
                    }
                } catch (err) {
                    log("热重载期间执行暂停失败:", err);
                    fadeState = "idle";
                    if (userTargetVolume !== null) {
                        callNativeVolume(userTargetVolume);
                        saveVolumeState(userTargetVolume, ipcProfile.volSignature, false);
                    }
                }
            } else if (oldState === "fadingOut" || oldState === "fadingIn" || oldState === "paused") {
                if (userTargetVolume !== null && ipcProfile.volSignature) {
                    callNativeVolume(userTargetVolume);
                    saveVolumeState(userTargetVolume, ipcProfile.volSignature, oldState === "paused");
                }
                fadeState = oldState === "paused" ? "paused" : "idle";
            } else if (userTargetVolume !== null && ipcProfile.volSignature) {
                saveVolumeState(userTargetVolume, ipcProfile.volSignature, false);
            }

            destroyWorker();
            panelStatusUpdater = null;
            window.removeEventListener("beforeunload", onBeforeUnload);

            gestureEvents.forEach((type) => {
                document.removeEventListener(type, onPotentialVolumeGesture, true);
            });

            if (window.channel && rawChannelCall) {
                window.channel.call = rawChannelCall;
                delete window.channel.__pauseFadeHooked;
            }
            if (window.channel && rawRegisterCall) {
                window.channel.registerCall = rawRegisterCall;
            }
            delete window.__pauseFadeCleanup;
        };

        return true;
    }

    let uiRegistered = registerPluginConfigUI();

    bootTimer = setInterval(() => {
        if (!uiRegistered) uiRegistered = registerPluginConfigUI();
        if (hookChannel() && uiRegistered) {
            clearInterval(bootTimer);
        }
    }, 100);
})();
