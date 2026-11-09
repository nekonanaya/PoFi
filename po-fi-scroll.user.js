
// ==UserScript==
// @name         Po-Fi Hydraulic Scroll
// @namespace    https://github.com/nekonanaya/PoFi
// @version      1.2.0
// @description  Global exponential damping scroll with nested container support
// @author       Nyanyaya & ChatGPT
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/nekonanaya/PoFi/main/po-fi-scroll.user.js
// @downloadURL  https://raw.githubusercontent.com/nekonanaya/PoFi/main/po-fi-scroll.user.js
// ==/UserScript==

(() => {
  'use strict';

  // ==========================================
  // 1. Parameters
  // ==========================================

  const TAU_MS = 45;
  const LINE_SIZE = 40;
  const EPSILON = 0.5;

  const INSTANCE_KEY = '__POFI_HYDRAULIC_SCROLL__';

  const states = new WeakMap();
  const activeStates = new Set();

  // ==========================================
  // 2. Cleanup previous instance
  // ==========================================

  if (typeof window[INSTANCE_KEY] === 'function') {
    window[INSTANCE_KEY]();
  }

  // ==========================================
  // 3. Scroll container utilities
  // ==========================================

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
    const height = container.clientHeight || window.innerHeight;

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

    const overflowY = getComputedStyle(container).overflowY;

    return /^(auto|scroll|overlay)$/.test(overflowY) &&
      getMaxScroll(container) > 1;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }

  // ==========================================
  // 4. Event protection
  // ==========================================

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

  // ==========================================
  // 5. Build nested scroll candidates
  // ==========================================

  function getCandidates(event) {
    const path = event.composedPath
      ? event.composedPath()
      : [event.target];

    const candidates = [];
    const seen = new Set();

    for (const node of path) {
      if (!(node instanceof Element)) continue;

      const container = normalizeContainer(node);

      if (container && !seen.has(container)) {
        seen.add(container);
        candidates.push(container);
      }
    }

    const root = getRoot();

    if (root && !seen.has(root)) {
      candidates.push(root);
    }

    return { path, candidates };
  }

  // ==========================================
  // 6. Wheel delta normalization
  // ==========================================

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

  // ==========================================
  // 7. Per-container state
  // ==========================================

  function getState(container) {
    let state = states.get(container);

    if (!state) {
      state = {
        container,
        currentY: container.scrollTop,
        targetY: container.scrollTop,
        lastTime: 0,
        raf: 0
      };

      states.set(container, state);
    }

    return state;
  }

  function getEffectivePosition(container) {
    const state = states.get(container);

    return state && state.raf
      ? state.targetY
      : container.scrollTop;
  }

  // ==========================================
  // 8. Find the first container that can scroll
  // ==========================================

  function findScrollableContainer(candidates, direction) {
    for (const container of candidates) {
      if (!isScrollable(container)) continue;

      const maxScroll = getMaxScroll(container);
      const current = getEffectivePosition(container);

      const canDown =
        direction > 0 &&
        maxScroll - current > EPSILON;

      const canUp =
        direction < 0 &&
        current > EPSILON;

      if (canDown || canUp) {
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

  // ==========================================
  // 9. State cleanup
  // ==========================================

  function finishState(state) {
    const container = state.container;

    if (state.raf) {
      cancelAnimationFrame(state.raf);
    }

    // Important: remove the cached state as well.
    if (container) {
      states.delete(container);
    }

    activeStates.delete(state);

    state.raf = 0;
    state.lastTime = 0;
    state.container = null;
  }

  // ==========================================
  // 10. Exponential damping animation
  // ==========================================

  function animate(state, time) {
    const container = state.container;

    if (!container || !container.isConnected) {
      finishState(state);
      return;
    }

    // The scheduled frame has now been consumed.
    state.raf = 0;

    const dt = state.lastTime
      ? Math.max(0, Math.min(32, time - state.lastTime))
      : 16;

    state.lastTime = time;

    const maxScroll = getMaxScroll(container);

    state.targetY = clamp(
      state.targetY,
      0,
      maxScroll
    );

    const alpha = 1 - Math.exp(-dt / TAU_MS);

    state.currentY +=
      (state.targetY - state.currentY) * alpha;

    state.currentY = clamp(
      state.currentY,
      0,
      maxScroll
    );

    container.scrollTop = state.currentY;

    if (
      Math.abs(state.targetY - state.currentY) > EPSILON
    ) {
      state.raf = requestAnimationFrame(
        nextTime => animate(state, nextTime)
      );
    } else {
      container.scrollTop = state.targetY;
      state.currentY = state.targetY;

      finishState(state);
    }
  }

  // ==========================================
  // 11. Wheel handler
  // ==========================================

  function onWheel(event) {
    const { path, candidates } = getCandidates(event);

    if (shouldIgnore(event, path)) {
      return;
    }

    const container = findScrollableContainer(
      candidates,
      Math.sign(event.deltaY)
    );

    if (!container) return;

    const delta = getDelta(event, container);

    if (!Number.isFinite(delta) || delta === 0) {
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
      Math.abs(nextTarget - state.targetY) < 0.01
    ) {
      return;
    }

    event.preventDefault();

    state.targetY = nextTarget;

    if (!state.raf) {
      activeStates.add(state);

      state.raf = requestAnimationFrame(
        time => animate(state, time)
      );
    }
  }

  // ==========================================
  // 12. Install
  // ==========================================

  window.addEventListener(
    'wheel',
    onWheel,
    { passive: false, capture: true }
  );

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

    if (window[INSTANCE_KEY] === cleanup) {
      delete window[INSTANCE_KEY];
    }
  }

  window[INSTANCE_KEY] = cleanup;

  console.log(
    `[Po-Fi] Hydraulic Scroll 1.2 initialized. τ=${TAU_MS}ms`
  );

})();
