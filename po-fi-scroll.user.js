
// ==UserScript==
// @name         Po-Fi Hydraulic Scroll
// @namespace    https://github.com/nekonanaya/PoFi
// @version      1.2.8
// @description  Global exponential damping scroll with instant RAF positioning and Bilibili root scrollbar visibility
// @author       Nyanyaya & 姐姐喵 & ChatGPT
// @match        *://*/*
// @updateURL    https://raw.githubusercontent.com/nekonanaya/PoFi/main/po-fi-scroll.user.js
// @downloadURL  https://raw.githubusercontent.com/nekonanaya/PoFi/main/po-fi-scroll.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const TAU_MS = 45;
  const LINE_SIZE = 40;
  const EPSILON = 0.5;
  const INSTANCE_KEY = '__POFI_HYDRAULIC_SCROLL__';
  const BILI_SCROLLBAR_STYLE_ID = 'pofi-bilibili-root-scrollbar';

  const states = new WeakMap();
  const activeStates = new Set();
  let scrollbarStyleObserver = null;

  // Remove previous instance before registering this one.
  if (typeof window[INSTANCE_KEY] === 'function') {
    window[INSTANCE_KEY]();
  }

  function getRoot() {
    return document.scrollingElement || document.documentElement;
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
    return Math.max(0, container.scrollHeight - height);
  }

  function isScrollable(container) {
    if (!container || !container.isConnected) return false;
    if (isRoot(container)) return getMaxScroll(container) > 1;

    // Exclude full-viewport shells that are commonly layout wrappers.
    if (Math.abs(container.clientHeight - window.innerHeight) <= 4) {
      return false;
    }

    const overflowY = getComputedStyle(container).overflowY;
    return /^(auto|scroll|overlay)$/.test(overflowY) &&
      getMaxScroll(container) > 1;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }

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
        node.matches('input, textarea, select, [role="textbox"]') ||
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

      if (container && !seen.has(container)) {
        seen.add(container);
        candidates.push(container);
      }
    }

    const root = getRoot();
    if (root && !seen.has(root)) candidates.push(root);

    return { path, candidates };
  }

  function getDelta(event, container) {
    if (event.deltaMode === 1) return event.deltaY * LINE_SIZE;

    if (event.deltaMode === 2) {
      return event.deltaY *
        (container.clientHeight || window.innerHeight);
    }

    return event.deltaY;
  }

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

  function findScrollableContainer(candidates, direction) {
    for (const container of candidates) {
      if (!isScrollable(container)) continue;

      const maxScroll = getMaxScroll(container);
      const state = states.get(container);

      const current = state?.raf
        ? state.targetY
        : container.scrollTop;

      const canScroll = direction > 0
        ? (maxScroll - current > EPSILON)
        : (current > EPSILON);

      if (canScroll) {
        if (getComputedStyle(container).scrollSnapType !== 'none') {
          return null;
        }

        return container;
      }

      const overscroll =
        getComputedStyle(container).overscrollBehaviorY;

      if (overscroll === 'contain' || overscroll === 'none') {
        return null;
      }
    }

    return null;
  }

  // Explicit instant positioning prevents the site's scroll-behavior:smooth
  // from starting a second native animation on every RAF frame.
  function setScrollPositionInstant(container, top) {
    if (isRoot(container)) {
      window.scrollTo({
        top,
        behavior: 'instant'
      });

      return;
    }

    container.scrollTo({
      top,
      behavior: 'instant'
    });
  }

  // Bilibili-only persistent root scrollbar.
  function installBilibiliRootScrollbar() {
    if (location.hostname !== 'www.bilibili.com') return;

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
      const parent = document.head || document.documentElement;

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
      scrollbarStyleObserver = new MutationObserver(() => attach());

      scrollbarStyleObserver.observe(document, {
        childList: true,
        subtree: true
      });
    }
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

  function animate(state, time) {
    const container = state.container;

    if (!container || !container.isConnected) {
      finishState(state);
      return;
    }

    const dt = state.lastTime
      ? Math.max(0, Math.min(64, time - state.lastTime))
      : 16;

    state.lastTime = time;

    const maxScroll = getMaxScroll(container);
    state.targetY = clamp(state.targetY, 0, maxScroll);

    const alpha = 1 - Math.exp(-dt / TAU_MS);

    state.currentY +=
      (state.targetY - state.currentY) * alpha;

    state.currentY = clamp(
      state.currentY,
      0,
      maxScroll
    );

    setScrollPositionInstant(
      container,
      state.currentY
    );

    if (Math.abs(state.targetY - state.currentY) > EPSILON) {
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

  function onWheel(event) {
    const { path, candidates } = getCandidates(event);

    if (shouldIgnore(event, path)) return;

    const container = findScrollableContainer(
      candidates,
      Math.sign(event.deltaY)
    );

    if (!container) return;

    const delta = getDelta(event, container);

    if (!Number.isFinite(delta) || delta === 0) return;

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

    if (Math.abs(nextTarget - state.targetY) < 0.01) {
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

  installBilibiliRootScrollbar();

  window.addEventListener('wheel', onWheel, {
    passive: false,
    capture: true
  });

  function cleanup() {
    window.removeEventListener('wheel', onWheel, true);

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
    `[Po-Fi] Hydraulic Scroll 1.2.8 active. ` +
    `τ=${TAU_MS}ms. Instant positioning enabled.`
  );
})();
