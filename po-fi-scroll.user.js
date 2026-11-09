// ==UserScript==
// @name         Po-Fi Hydraulic Scroll
// @namespace    https://github.com/nekonanaya/PoFi
// @version      1.2.9
// @description  Adaptive exponential damping scroll with instant RAF positioning and Bilibili root scrollbar visibility
// @author       Nyanyaya & 姐姐喵
// @match        *://*/*
// @updateURL    https://raw.githubusercontent.com/nekonanaya/PoFi/main/po-fi-scroll.user.js
// @downloadURL  https://raw.githubusercontent.com/nekonanaya/PoFi/main/po-fi-scroll.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // =========================================================
  // 1. CONFIGURATION
  // =========================================================

  const WHEEL_GAIN = 1.00;

  // Adaptive damping range.
  const TAU_MIN_MS = 34;
  const TAU_MAX_MS = 68;

  // Input velocity reference (CSS pixels per millisecond).
  const SPEED_REFERENCE_PX_PER_MS = 2.6;

  // Velocity filtering and idle reset.
  const SPEED_FILTER_MS = 100;
  const SPEED_RESET_MS = 220;

  const LINE_SIZE = 40;
  const EPSILON = 0.5;
  const INSTANCE_KEY = '__POFI_HYDRAULIC_SCROLL__';

  const BILI_SCROLLBAR_STYLE_ID =
    'pofi-bilibili-root-scrollbar';

  const states = new WeakMap();
  const activeStates = new Set();

  let scrollbarStyleObserver = null;

  // =========================================================
  // 2. INSTANCE CLEANUP
  // =========================================================

  if (typeof window[INSTANCE_KEY] === 'function') {
    window[INSTANCE_KEY]();
  }

  // =========================================================
  // 3. SCROLL CONTAINER UTILITIES
  // =========================================================

  function getRoot() {
    return document.scrollingElement ||
      document.documentElement;
  }

  function isRoot(container) {
    return container === getRoot() ||
      container === document.documentElement ||
      container === document.body;
  }

  function normalizeContainer(container) {
    return isRoot(container) ? getRoot() : container;
  }

  function getMaxScroll(container) {
    const height =
      container.clientHeight || window.innerHeight;

    return Math.max(
      0,
      container.scrollHeight - height
    );
  }

  function isScrollable(container) {
    if (!container || !container.isConnected) {
      return false;
    }

    // The document root is special:
    // its computed overflowY may be "visible".
    if (isRoot(container)) {
      return getMaxScroll(container) > 1;
    }

    const overflowY =
      getComputedStyle(container).overflowY;

    return /^(auto|scroll|overlay)$/.test(overflowY) &&
      getMaxScroll(container) > 1;
  }

  function clamp(value, min, max) {
    return Math.max(
      min,
      Math.min(value, max)
    );
  }

  // =========================================================
  // 4. INPUT FILTERING
  // =========================================================

  function shouldIgnore(event, path) {
    if (
      event.defaultPrevented ||
      !event.cancelable ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.metaKey ||
      event.deltaY === 0 ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
    ) {
      return true;
    }

    for (const node of path) {
      if (!(node instanceof Element)) continue;

      if (
        // Preserve native NCM playback lyric scrolling.
        node.matches(
          '.g-singlec-ct .n-single .lyric, ' +
          '.g-singlec-ct .n-single .rnp-lyrics'
        ) ||

        node.hasAttribute('data-pofi-native-scroll') ||

        node.matches(
          'input, textarea, select, [role="textbox"]'
        ) ||

        node.isContentEditable
      ) {
        return true;
      }
    }

    return false;
  }

  function getCandidates(event) {
    const path = event.composedPath
      ? event.composedPath()
      : [event.target];

    const candidates = [];
    const seen = new Set();

    for (const node of path) {
      if (!(node instanceof Element)) continue;

      const container = normalizeContainer(node);

      if (
        container &&
        !seen.has(container)
      ) {
        seen.add(container);
        candidates.push(container);
      }
    }

    const root = getRoot();

    if (root && !seen.has(root)) {
      candidates.push(root);
    }

    return {
      path,
      candidates
    };
  }

  function getDelta(event, container) {
    if (event.deltaMode === 1) {
      return event.deltaY * LINE_SIZE;
    }

    if (event.deltaMode === 2) {
      return event.deltaY *
        (container.clientHeight || window.innerHeight);
    }

    return event.deltaY;
  }

  // =========================================================
  // 5. ADAPTIVE HYDRAULIC DAMPING
  // =========================================================

  function getAdaptiveTau(inputSpeed) {
    const normalized = clamp(
      inputSpeed / SPEED_REFERENCE_PX_PER_MS,
      0,
      1
    );

    // Smoothstep interpolation:
    // continuous transition without abrupt parameter switching.
    const curve =
      normalized * normalized *
      (3 - 2 * normalized);

    return TAU_MIN_MS +
      (TAU_MAX_MS - TAU_MIN_MS) * curve;
  }

  function updateAdaptiveDamping(state, delta, now) {
    let elapsed = state.lastWheelTime
      ? now - state.lastWheelTime
      : 16;

    // Start a fresh input sequence after idle.
    if (elapsed > SPEED_RESET_MS) {
      state.inputSpeed = 0;
      elapsed = 16;
    }

    const sampleDt = clamp(
      elapsed,
      8,
      120
    );

    const instantaneousSpeed =
      Math.abs(delta) / sampleDt;

    const filterDt = Math.min(
      sampleDt,
      32
    );

    const alpha =
      1 - Math.exp(
        -filterDt / SPEED_FILTER_MS
      );

    // Low-pass filtering prevents damping jitter.
    state.inputSpeed +=
      (
        instantaneousSpeed -
        state.inputSpeed
      ) * alpha;

    state.tauMs = getAdaptiveTau(
      state.inputSpeed
    );

    state.lastWheelTime = now;
  }

  // =========================================================
  // 6. SCROLL CONTAINER SELECTION
  // =========================================================

  function findScrollableContainer(candidates, direction) {
    for (const container of candidates) {
      if (!isScrollable(container)) continue;

      const maxScroll = getMaxScroll(container);
      const state = states.get(container);

      const current =
        state && state.raf
          ? state.targetY
          : container.scrollTop;

      const canScrollDown =
        direction > 0 &&
        maxScroll - current > EPSILON;

      const canScrollUp =
        direction < 0 &&
        current > EPSILON;

      if (canScrollDown || canScrollUp) {
        const style = getComputedStyle(container);

        // Preserve intentional scroll-snap behavior.
        if (style.scrollSnapType !== 'none') {
          return null;
        }

        return container;
      }

      // Respect explicit scroll-chain boundaries.
      const overscroll =
        getComputedStyle(container).overscrollBehaviorY;

      if (
        overscroll === 'contain' ||
        overscroll === 'none'
      ) {
        return null;
      }
    }

    return null;
  }

  // =========================================================
  // 7. STATE MANAGEMENT
  // =========================================================

  function getState(container) {
    let state = states.get(container);

    if (!state) {
      const current = container.scrollTop;

      state = {
        container,

        currentY: current,
        targetY: current,

        lastTime: 0,
        raf: 0,

        // Adaptive damping state.
        inputSpeed: 0,
        tauMs: TAU_MIN_MS,
        lastWheelTime: 0
      };

      states.set(container, state);
    }

    return state;
  }

  function finishState(state) {
    const container = state.container;

    if (state.raf) {
      cancelAnimationFrame(state.raf);
    }

    if (container) {
      states.delete(container);
    }

    activeStates.delete(state);

    state.raf = 0;
    state.lastTime = 0;
    state.container = null;
  }

  // =========================================================
  // 8. INSTANT SCROLL POSITIONING
  // =========================================================

  function setScrollPositionInstant(container, top) {
    // Route root scrolling through the viewport.
    if (isRoot(container)) {
      window.scrollTo({
        top,
        behavior: 'instant'
      });

      return;
    }

    // Prevent the site's scroll-behavior:smooth
    // from starting a competing animation.
    container.scrollTo({
      top,
      behavior: 'instant'
    });
  }

  // =========================================================
  // 9. BILIBILI ROOT SCROLLBAR
  // =========================================================

  function installBilibiliRootScrollbar() {
    if (location.hostname !== 'www.bilibili.com') {
      return;
    }

    if (document.getElementById(BILI_SCROLLBAR_STYLE_ID)) {
      return;
    }

    const style = document.createElement('style');
    style.id = BILI_SCROLLBAR_STYLE_ID;

    style.textContent = `
      html:root {
        scrollbar-width: auto !important;
        scrollbar-color: auto !important;
      }

      html:root::-webkit-scrollbar {
        width: 12px !important;
        height: 12px !important;
      }

      html:root::-webkit-scrollbar-thumb {
        background-color: rgba(128, 128, 128, 0.65) !important;
        border: 3px solid transparent !important;
        background-clip: padding-box !important;
        border-radius: 999px !important;
      }

      html:root::-webkit-scrollbar-track {
        background: transparent !important;
      }
    `;

    const attach = () => {
      const parent =
        document.head || document.documentElement;

      if (!parent) return false;

      if (!document.getElementById(BILI_SCROLLBAR_STYLE_ID)) {
        parent.appendChild(style);
      }

      if (scrollbarStyleObserver) {
        scrollbarStyleObserver.disconnect();
        scrollbarStyleObserver = null;
      }

      return true;
    };

    if (!attach()) {
      scrollbarStyleObserver =
        new MutationObserver(() => attach());

      scrollbarStyleObserver.observe(document, {
        childList: true,
        subtree: true
      });
    }
  }

  // =========================================================
  // 10. RAF ANIMATION
  // =========================================================

  function animate(state, time) {
    const container = state.container;

    if (
      !container ||
      !container.isConnected
    ) {
      finishState(state);
      return;
    }

    const dt = state.lastTime
      ? Math.max(
          0,
          Math.min(64, time - state.lastTime)
        )
      : 16;

    state.lastTime = time;

    // Re-read geometry during animation.
    // This preserves correctness when dynamic page content
    // changes the scrollable height.
    const maxScroll = getMaxScroll(container);

    state.targetY = clamp(
      state.targetY,
      0,
      maxScroll
    );

    // Adaptive exponential damping.
    const alpha =
      1 - Math.exp(
        -dt / state.tauMs
      );

    state.currentY +=
      (
        state.targetY -
        state.currentY
      ) * alpha;

    state.currentY = clamp(
      state.currentY,
      0,
      maxScroll
    );

    setScrollPositionInstant(
      container,
      state.currentY
    );

    if (
      Math.abs(
        state.targetY -
        state.currentY
      ) > EPSILON
    ) {
      state.raf = requestAnimationFrame(
        nextTime => animate(state, nextTime)
      );
    } else {
      setScrollPositionInstant(
        container,
        state.targetY
      );

      state.currentY = state.targetY;

      finishState(state);
    }
  }

  // =========================================================
  // 11. WHEEL HANDLER
  // =========================================================

  function onWheel(event) {
    const {
      path,
      candidates
    } = getCandidates(event);

    if (shouldIgnore(event, path)) {
      return;
    }

    const container = findScrollableContainer(
      candidates,
      Math.sign(event.deltaY)
    );

    if (!container) {
      return;
    }

    const delta =
      getDelta(event, container) * WHEEL_GAIN;

    if (
      !Number.isFinite(delta) ||
      delta === 0
    ) {
      return;
    }

    const state = getState(container);

    if (!state.raf) {
      state.currentY = container.scrollTop;
      state.targetY = container.scrollTop;
      state.lastTime = 0;
    }

    const maxScroll = getMaxScroll(container);

    const nextTarget = clamp(
      state.targetY + delta,
      0,
      maxScroll
    );

    if (
      Math.abs(
        nextTarget - state.targetY
      ) < 0.01
    ) {
      return;
    }

    // Only accepted scroll input affects adaptive damping.
    updateAdaptiveDamping(
      state,
      delta,
      performance.now()
    );

    event.preventDefault();
    state.targetY = nextTarget;

    if (!state.raf) {
      activeStates.add(state);

      state.raf = requestAnimationFrame(
        time => animate(state, time)
      );
    }
  }

  // =========================================================
  // 12. INITIALIZATION
  // =========================================================

  installBilibiliRootScrollbar();

  window.addEventListener('wheel', onWheel, {
    passive: false,
    capture: true
  });

  // =========================================================
  // 13. CLEANUP
  // =========================================================

  function cleanup() {
    window.removeEventListener(
      'wheel',
      onWheel,
      true
    );

    for (const state of [...activeStates]) {
      finishState(state);
    }

    activeStates.clear();

    if (scrollbarStyleObserver) {
      scrollbarStyleObserver.disconnect();
      scrollbarStyleObserver = null;
    }

    const scrollbarStyle = document.getElementById(
      BILI_SCROLLBAR_STYLE_ID
    );

    if (scrollbarStyle) {
      scrollbarStyle.remove();
    }

    if (window[INSTANCE_KEY] === cleanup) {
      delete window[INSTANCE_KEY];
    }
  }

  window[INSTANCE_KEY] = cleanup;

  console.log(
    `[Po-Fi] Hydraulic Scroll 1.2.9 active. ` +
    `Adaptive τ=${TAU_MIN_MS}-${TAU_MAX_MS}ms. ` +
    `Instant positioning enabled.`
  );
})();
