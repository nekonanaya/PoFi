// ==UserScript==
// @name         Po-Fi Hydraulic Scroll
// @namespace    https://github.com/nekonanaya/PoFi
// @version      1.2.24
// @description  Adaptive exponential damping scroll with instant RAF positioning and floating overlay indicator
// @author       Nyanyaya & 姐姐喵 & GPT龙娘
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
  const KINETIC_BOOST_MAX = 1.22;

  const TAU_MIN_MS = 46;
  const TAU_MAX_MS = 62;

  const SPEED_REFERENCE_PX_PER_MS = 4.5;
  const SPEED_FILTER_MS = 85;
  const SPEED_RESET_MS = 180;

  const LINE_SIZE = 40;
  const EPSILON = 0.5;
  const BOUNDARY_EPSILON = 1.5;
  const MIN_CHILD_SCROLL_PX = 6;
  const HORIZONTAL_BLEED_MAX_PX = 24;
  const CODE_BLOCK_BLEED_MAX_PX = 36;
  const ANCHOR_SHIFT_TOLERANCE = 4.0;

  const INDICATOR_ENABLED = true;

  const SCROLL_EXCLUDED_HOSTS = [
    'chatgpt.com',
    'chat.openai.com'
  ];

  const INDICATOR_MODE = 'exclude';
  const INDICATOR_HOSTS = [
    'x.com',
    'twitter.com'
  ];

  const INDICATOR_HIDE_DELAY_MS = 900;
  const INDICATOR_FADE_CLEANUP_MS = 240;
  const INDICATOR_TRACK_REFRESH_MS = 120;
  const INDICATOR_PADDING_PX = 4;
  const INDICATOR_MIN_THUMB_PX = 28;
  const INSTANCE_KEY = '__POFI_HYDRAULIC_SCROLL__';

  const IGNORE_STATIC_SELECTOR =
    '.g-singlec-ct .n-single .lyric, ' +
    '.g-singlec-ct .n-single .rnp-lyrics, ' +
    '[data-pofi-native-scroll], ' +
    'select, input[type="number"], input[type="range"]';

  const NAV_KEYS = new Set([
    'PageUp',
    'PageDown',
    'Home',
    'End',
    'ArrowUp',
    'ArrowDown',
    ' '
  ]);

  const states = new WeakMap();
  const activeStates = new Set();
  let supportsInstantBehavior = true;

  // =========================================================
  // 2. INSTANCE CLEANUP & HOST FILTERING
  // =========================================================

  if (typeof window[INSTANCE_KEY] === 'function') {
    try {
      window[INSTANCE_KEY]();
    } catch (error) {
      console.warn(
        '[Po-Fi] Previous instance cleanup failed:',
        error
      );
    }
  }

  function matchesHostPattern(hostname, pattern) {
    const cleanHost = hostname.toLowerCase();
    const cleanPattern = String(pattern)
      .trim()
      .toLowerCase()
      .replace(/^\*\./, '');

    if (!cleanPattern) {
      return false;
    }

    return cleanHost === cleanPattern ||
      cleanHost.endsWith(`.${cleanPattern}`);
  }

  function isScrollExcludedHost() {
    const hostname = location.hostname;
    return SCROLL_EXCLUDED_HOSTS.some(
      pattern => matchesHostPattern(hostname, pattern)
    );
  }

  if (isScrollExcludedHost()) {
    console.log(
      `[Po-Fi] Hydraulic Scroll bypassed on ${location.hostname} (native scroll preserved).`
    );
    return;
  }

  function checkIndicatorAllowed() {
    if (!INDICATOR_ENABLED) {
      return false;
    }

    const hostname = location.hostname;
    const matched = INDICATOR_HOSTS.some(
      pattern => matchesHostPattern(hostname, pattern)
    );

    return INDICATOR_MODE === 'include' ? matched : !matched;
  }

  const INDICATOR_ALLOWED = checkIndicatorAllowed();

  // =========================================================
  // 3. SCROLL CONTAINER UTILITIES
  // =========================================================

  function getRoot() {
    return document.scrollingElement ||
      document.documentElement;
  }

  function isRoot(container) {
    const root = getRoot();
    return container === root ||
      (container === document.documentElement && root === document.documentElement);
  }

  function normalizeContainer(container) {
    return isRoot(container) ? getRoot() : container;
  }

  function getScrollTop(container) {
    if (isRoot(container)) {
      return window.scrollY ?? window.pageYOffset ?? container.scrollTop;
    }

    return container.scrollTop;
  }

  function getViewportHeight(container) {
    return isRoot(container)
      ? (container.clientHeight || window.innerHeight)
      : container.clientHeight;
  }

  function getMaxScroll(container) {
    const height = getViewportHeight(container);

    if (height <= 0) {
      return 0;
    }

    return Math.max(
      0,
      container.scrollHeight - height
    );
  }

  function isRootOverflowLocked(htmlStyle) {
    const html = document.documentElement;
    const body = document.body;

    const resolvedHtmlStyle = htmlStyle ||
      (html ? getComputedStyle(html) : null);

    const htmlOverflow = resolvedHtmlStyle
      ? resolvedHtmlStyle.overflowY
      : 'visible';

    if (htmlOverflow === 'hidden' || htmlOverflow === 'clip') {
      return true;
    }

    if (htmlOverflow === 'visible' && body) {
      const bodyOverflow = getComputedStyle(body).overflowY;
      if (bodyOverflow === 'hidden' || bodyOverflow === 'clip') {
        return true;
      }
    }

    return false;
  }

  function isBodyPropagatedToViewport(container, htmlStyle) {
    if (container !== document.body || isRoot(container)) {
      return false;
    }

    const html = document.documentElement;
    const resolvedHtmlStyle = htmlStyle ||
      (html ? getComputedStyle(html) : null);

    if (!resolvedHtmlStyle) {
      return false;
    }

    return resolvedHtmlStyle.overflowX === 'visible' &&
      resolvedHtmlStyle.overflowY === 'visible';
  }

  function isHorizontalBleedBox(container, maxScroll) {
    return maxScroll <= HORIZONTAL_BLEED_MAX_PX &&
      container.scrollWidth > container.clientWidth + BOUNDARY_EPSILON;
  }

  function isCodeBlockBleedBox(container, maxScroll) {
    if (maxScroll > CODE_BLOCK_BLEED_MAX_PX) {
      return false;
    }

    return container.tagName === 'PRE' ||
      container.tagName === 'CODE' ||
      (container.firstElementChild !== null && container.firstElementChild.tagName === 'CODE');
  }

  function clamp(value, min, max) {
    return Math.max(
      min,
      Math.min(value, max)
    );
  }
      // =========================================================
  // 4. FLOATING OVERLAY SCROLLBAR (SHADOW DOM)
  // =========================================================

  const indicator = {
    host: null,
    track: null,
    thumbHit: null,
    pill: null,

    container: null,
    rectTop: 0,
    rectRight: 0,
    rectHeight: 0,
    lastTrackTime: 0,
    lastTrackTransform: '',
    lastTrackHeight: '',

    maxScroll: 0,
    viewportHeight: 0,
    usableHeight: 0,
    thumbHeight: 0,
    lastThumbHeight: -1,

    visible: false,
    hovering: false,
    dragging: false,
    dragStartY: 0,
    dragStartScrollTop: 0,
    hideTimer: 0,
    cleanupTimer: 0
  };

  function ensureIndicator() {
    if (!INDICATOR_ALLOWED) {
      return false;
    }

    if (indicator.host) {
      return true;
    }

    const mountTarget = document.documentElement;
    if (!mountTarget) {
      return false;
    }

    const host = document.createElement('div');
    host.setAttribute('data-pofi-indicator', 'true');
    host.style.cssText =
      'position:fixed;inset:0;pointer-events:none;' +
      'z-index:2147483647;contain:layout style;';

    const shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      .track {
        position: fixed;
        top: 0;
        left: 0;
        width: 14px;
        height: 0;
        pointer-events: none;
      }
      .thumb-hit {
        position: absolute;
        top: 0;
        right: 0;
        width: 14px;
        min-height: 28px;
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        will-change: auto;
        transition: opacity 0.2s ease;
        cursor: default;
        touch-action: none;
      }
      .pill {
        position: absolute;
        top: 0;
        bottom: 0;
        right: 3px;
        width: 4px;
        border-radius: 999px;
        background: rgba(128, 128, 136, 0.56);
        box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.3);
        transition: width 0.14s ease, background 0.14s ease, right 0.14s ease;
      }
      .thumb-hit:hover .pill,
      .thumb-hit.dragging .pill {
        width: 7px;
        right: 2px;
        background: rgba(128, 128, 136, 0.82);
      }
    `;

    const track = document.createElement('div');
    track.className = 'track';

    const thumbHit = document.createElement('div');
    thumbHit.className = 'thumb-hit';

    const pill = document.createElement('div');
    pill.className = 'pill';

    thumbHit.appendChild(pill);
    track.appendChild(thumbHit);
    shadow.appendChild(style);
    shadow.appendChild(track);
    mountTarget.appendChild(host);

    thumbHit.addEventListener('pointerenter', () => {
      indicator.hovering = true;
      clearIndicatorTimers();
    });

    thumbHit.addEventListener('pointerleave', () => {
      indicator.hovering = false;
      if (!indicator.dragging && !isIndicatorAnimating()) {
        scheduleHideIndicator();
      }
    });

    thumbHit.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !indicator.container || !indicator.container.isConnected) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      indicator.dragging = true;
      indicator.dragStartY = event.clientY;
      indicator.dragStartScrollTop = getScrollTop(indicator.container);
      indicator.maxScroll = getMaxScroll(indicator.container);
      indicator.viewportHeight = getViewportHeight(indicator.container);
      thumbHit.classList.add('dragging');
      clearIndicatorTimers();

      const state = states.get(indicator.container);
      if (state) {
        finishState(state, {
          resetVelocity: true
        });
      }

      try {
        thumbHit.setPointerCapture(event.pointerId);
      } catch {}
    });

    thumbHit.addEventListener('pointermove', event => {
      if (!indicator.dragging || !indicator.container) {
        return;
      }

      const scrollRange = indicator.usableHeight - indicator.thumbHeight;
      if (scrollRange <= 0 || indicator.maxScroll <= 0) {
        return;
      }

      const deltaY = event.clientY - indicator.dragStartY;
      const scrollDelta = deltaY * (indicator.maxScroll / scrollRange);
      const nextTop = clamp(
        indicator.dragStartScrollTop + scrollDelta,
        0,
        indicator.maxScroll
      );

      setScrollPositionInstant(indicator.container, nextTop);
      renderIndicator(
        indicator.container,
        nextTop,
        indicator.maxScroll,
        indicator.viewportHeight
      );
    });

    const endDrag = event => {
      if (!indicator.dragging) {
        return;
      }

      indicator.dragging = false;
      thumbHit.classList.remove('dragging');

      try {
        if (thumbHit.hasPointerCapture(event.pointerId)) {
          thumbHit.releasePointerCapture(event.pointerId);
        }
      } catch {}

      indicator.hovering = thumbHit.matches(':hover');

      if (!indicator.hovering && !isIndicatorAnimating()) {
        scheduleHideIndicator();
      }
    };

    thumbHit.addEventListener('pointerup', endDrag);
    thumbHit.addEventListener('pointercancel', endDrag);

    indicator.host = host;
    indicator.track = track;
    indicator.thumbHit = thumbHit;
    indicator.pill = pill;

    return true;
  }

  function isIndicatorAnimating() {
    if (!indicator.container) {
      return false;
    }

    const state = states.get(indicator.container);
    return Boolean(state && state.raf);
  }

  function clearIndicatorTimers() {
    if (indicator.hideTimer) {
      clearTimeout(indicator.hideTimer);
      indicator.hideTimer = 0;
    }

    if (indicator.cleanupTimer) {
      clearTimeout(indicator.cleanupTimer);
      indicator.cleanupTimer = 0;
    }
  }

  function hideIndicator() {
    clearIndicatorTimers();
    indicator.visible = false;

    if (indicator.thumbHit) {
      indicator.thumbHit.style.opacity = '0';
      indicator.thumbHit.style.pointerEvents = 'none';

      indicator.cleanupTimer = setTimeout(() => {
        indicator.cleanupTimer = 0;
        if (!indicator.visible && indicator.thumbHit) {
          indicator.thumbHit.style.willChange = 'auto';
          indicator.thumbHit.style.visibility = 'hidden';
        }
      }, INDICATOR_FADE_CLEANUP_MS);
    }
  }

  function scheduleHideIndicator() {
    if (!indicator.visible && !indicator.hideTimer) {
      return;
    }

    clearIndicatorTimers();

    if (indicator.hovering || indicator.dragging || isIndicatorAnimating()) {
      return;
    }

    indicator.hideTimer = setTimeout(() => {
      indicator.hideTimer = 0;
      hideIndicator();
    }, INDICATOR_HIDE_DELAY_MS);
  }

  function refreshIndicatorTrack(container, force = false) {
    if (!ensureIndicator()) {
      return;
    }

    clearIndicatorTimers();
    indicator.thumbHit.style.visibility = 'visible';
    indicator.thumbHit.style.willChange = 'transform, opacity';

    const containerChanged = indicator.container !== container;
    if (containerChanged) {
      indicator.hovering = false;
      indicator.container = container;
    }

    const now = performance.now();
    const shouldMeasure =
      force ||
      containerChanged ||
      !indicator.visible ||
      now - indicator.lastTrackTime > INDICATOR_TRACK_REFRESH_MS;

    if (!shouldMeasure) {
      return;
    }

    indicator.lastTrackTime = now;

    if (isRoot(container)) {
      indicator.rectTop = 0;
      indicator.rectRight = window.innerWidth;
      indicator.rectHeight = window.innerHeight;
    } else {
      const rect = container.getBoundingClientRect();
      indicator.rectTop = rect.top;
      indicator.rectRight = rect.right;
      indicator.rectHeight = rect.height;
    }

    const nextTransform =
      `translate3d(${(indicator.rectRight - 14).toFixed(1)}px,${indicator.rectTop.toFixed(1)}px,0)`;
    const nextHeight = `${Math.max(0, indicator.rectHeight).toFixed(1)}px`;

    if (nextTransform !== indicator.lastTrackTransform) {
      indicator.track.style.transform = nextTransform;
      indicator.lastTrackTransform = nextTransform;
    }

    if (nextHeight !== indicator.lastTrackHeight) {
      indicator.track.style.height = nextHeight;
      indicator.lastTrackHeight = nextHeight;
    }
  }

  function renderIndicator(container, currentY, maxScroll, viewportHeight) {
    if (!indicator.track || indicator.container !== container) {
      return;
    }

    if (
      maxScroll <= BOUNDARY_EPSILON ||
      viewportHeight <= 0 ||
      indicator.rectHeight < 40
    ) {
      hideIndicator();
      return;
    }

    const scrollHeight = maxScroll + viewportHeight;
    const usableHeight = Math.max(0, indicator.rectHeight - INDICATOR_PADDING_PX * 2);

    if (usableHeight <= INDICATOR_MIN_THUMB_PX) {
      hideIndicator();
      return;
    }

    const thumbHeight = clamp(
      (viewportHeight / scrollHeight) * usableHeight,
      INDICATOR_MIN_THUMB_PX,
      usableHeight
    );

    const progress = clamp(currentY / maxScroll, 0, 1);
    const thumbY =
      INDICATOR_PADDING_PX +
      progress * (usableHeight - thumbHeight);

    indicator.maxScroll = maxScroll;
    indicator.viewportHeight = viewportHeight;
    indicator.usableHeight = usableHeight;
    indicator.thumbHeight = thumbHeight;

    if (Math.abs(thumbHeight - indicator.lastThumbHeight) > 0.3) {
      indicator.thumbHit.style.height = `${thumbHeight.toFixed(1)}px`;
      indicator.lastThumbHeight = thumbHeight;
    }

    indicator.thumbHit.style.transform =
      `translate3d(0,${thumbY.toFixed(2)}px,0)`;

    if (!indicator.visible) {
      indicator.visible = true;
      indicator.thumbHit.style.opacity = '1';
      indicator.thumbHit.style.pointerEvents = 'auto';
    }
  }

  function destroyIndicator() {
    clearIndicatorTimers();

    if (indicator.host && indicator.host.parentNode) {
      indicator.host.parentNode.removeChild(indicator.host);
    }

    indicator.host = null;
    indicator.track = null;
    indicator.thumbHit = null;
    indicator.pill = null;
    indicator.container = null;
    indicator.lastTrackTime = 0;
    indicator.lastTrackTransform = '';
    indicator.lastTrackHeight = '';
    indicator.lastThumbHeight = -1;
    indicator.visible = false;
    indicator.hovering = false;
    indicator.dragging = false;
  }
      // =========================================================
  // 5. INPUT FILTERING
  // =========================================================

  function isIgnoredWheelEvent(event) {
    return event.defaultPrevented ||
      !event.cancelable ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.metaKey ||
      event.deltaY === 0 ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY);
  }

  function getEventPath(event) {
    return event.composedPath
      ? event.composedPath()
      : [event.target];
  }

  function hasIgnoredAncestor(path) {
    for (const node of path) {
      if (!(node instanceof Element)) continue;

      if (node.matches(IGNORE_STATIC_SELECTOR)) {
        return true;
      }

      if (
        (node.isContentEditable ||
          node.tagName === 'TEXTAREA' ||
          node.getAttribute('role') === 'textbox') &&
        node.scrollHeight > node.clientHeight + MIN_CHILD_SCROLL_PX
      ) {
        return true;
      }
    }

    return false;
  }

  function getCandidates(path) {
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

    return candidates;
  }

  function getDelta(event, viewportHeight) {
    if (event.deltaMode === 1) return event.deltaY * LINE_SIZE;
    if (event.deltaMode === 2) return event.deltaY * viewportHeight;
    return event.deltaY;
  }

  // =========================================================
  // 6. ADAPTIVE HYDRAULIC DAMPING
  // =========================================================

  // Pure helpers: input speed maps continuously to one coherent motion profile.
  function smoothstep01(value) {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  }

  function getMotionProfile(inputSpeed) {
    const speed = clamp(
      inputSpeed / SPEED_REFERENCE_PX_PER_MS,
      0,
      1
    );
    const curve = smoothstep01(speed);

    return {
      tauMs: TAU_MAX_MS - (TAU_MAX_MS - TAU_MIN_MS) * curve,
      wheelGain: WHEEL_GAIN * (1 + (KINETIC_BOOST_MAX - 1) * curve)
    };
  }

  // Exact first-order response over elapsed time; no frame-rate-specific easing.
  function dampToward(current, target, elapsedMs, tauMs) {
    const blend = 1 - Math.exp(-elapsedMs / tauMs);
    return current + (target - current) * blend;
  }

  function updateAdaptiveDamping(state, delta, now) {
    let elapsed = state.lastWheelTime
      ? now - state.lastWheelTime
      : 80;

    if (elapsed > SPEED_RESET_MS) {
      state.inputSpeed = 0;
      elapsed = 80;
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

    state.inputSpeed +=
      (
        instantaneousSpeed -
        state.inputSpeed
      ) * alpha;

    const profile = getMotionProfile(state.inputSpeed);
    state.tauMs = profile.tauMs;
    state.wheelGain = profile.wheelGain;

    state.lastWheelTime = now;
  }

  // =========================================================
  // 7. SCROLL CONTAINER SELECTION
  // =========================================================

  function isContainerBlocked(container, state, direction, actualTop, maxScroll) {
    return !isRoot(container) &&
      Boolean(state) &&
      !state.raf &&
      state.blockedDir === direction &&
      Math.abs(actualTop - state.blockedTop) < 0.5 &&
      Math.abs(maxScroll - state.blockedMaxScroll) < 0.5;
  }

  function findScrollableContainer(candidates, direction) {
    let htmlStyle = null;
    const getHtmlStyle = () => {
      if (!htmlStyle && document.documentElement) {
        htmlStyle = getComputedStyle(document.documentElement);
      }
      return htmlStyle;
    };

    for (const container of candidates) {
      if (!container || !container.isConnected) continue;

      const rootContainer = isRoot(container);
      let viewportHeight = 0;
      let maxScroll = 0;
      let style;

      if (rootContainer) {
        const hs = getHtmlStyle();
        if (isRootOverflowLocked(hs)) continue;

        viewportHeight = getViewportHeight(container);
        if (viewportHeight <= 0) continue;

        maxScroll = Math.max(0, container.scrollHeight - viewportHeight);
        if (maxScroll <= BOUNDARY_EPSILON) continue;

        style = container === document.documentElement && hs
          ? hs
          : getComputedStyle(container);
      } else {
        viewportHeight = getViewportHeight(container);
        if (viewportHeight <= 0) continue;

        maxScroll = Math.max(0, container.scrollHeight - viewportHeight);
        if (maxScroll <= MIN_CHILD_SCROLL_PX) continue;
        if (isHorizontalBleedBox(container, maxScroll)) continue;
        if (isCodeBlockBleedBox(container, maxScroll)) continue;
        if (isBodyPropagatedToViewport(container, getHtmlStyle())) continue;

        style = getComputedStyle(container);
        if (!/^(auto|scroll|overlay)$/.test(style.overflowY)) continue;
      }

      const actualTop = getScrollTop(container);
      const state = states.get(container);

      if (isContainerBlocked(container, state, direction, actualTop, maxScroll)) {
        continue;
      }

      const currentTop = state && state.raf ? state.targetY : actualTop;
      const canScroll = direction > 0
        ? maxScroll - currentTop > BOUNDARY_EPSILON
        : currentTop > BOUNDARY_EPSILON;

      if (canScroll) {
        if (style.scrollSnapType !== 'none') return null;

        // Carry the measurements forward: onWheel must not measure this node again.
        return { container, viewportHeight, maxScroll, actualTop };
      }

      if (style.overscrollBehaviorY === 'contain' || style.overscrollBehaviorY === 'none') {
        return null;
      }
    }

    return null;
  }
      // =========================================================
  // 8. STATE MANAGEMENT & ANCHOR GUARD
  // =========================================================

  function getState(container, initialTop = getScrollTop(container)) {
    let state = states.get(container);

    if (!state) {
      const current = initialTop;

      state = {
        container,

        currentY: current,
        targetY: current,
        lastAppliedY: current,

        lastTime: 0,
        raf: 0,

        inputSpeed: 0,
        tauMs: TAU_MAX_MS,
        wheelGain: WHEEL_GAIN,
        lastWheelTime: 0,
        lastWheelDirection: 0,

        animStartTop: current,
        animDirection: 0,
        animMoved: false,
        animCheckFrames: 0,

        blockedDir: 0,
        blockedTop: 0,
        blockedMaxScroll: 0
      };

      states.set(container, state);
    }

    return state;
  }

  function reconcileAnchorShift(state, container, maxScroll, actualTop) {
    const shift = actualTop - state.lastAppliedY;

    if (Math.abs(shift) <= ANCHOR_SHIFT_TOLERANCE) {
      return;
    }

    // Let the stuck-container detector handle clamped non-root containers.
    if (
      !isRoot(container) &&
      !state.animMoved &&
      state.animDirection !== 0 &&
      (actualTop - state.animStartTop) * state.animDirection < 0.5 &&
      Math.abs(state.lastAppliedY - state.animStartTop) >= 2
    ) {
      return;
    }

    // Follow any browser scroll-anchoring / content-visibility shift
    // without blind-spot pullbacks or resetting velocity.
    state.currentY = clamp(state.currentY + shift, 0, maxScroll);
    state.targetY = clamp(state.targetY + shift, 0, maxScroll);
    state.animStartTop = clamp(state.animStartTop + shift, 0, maxScroll);
    state.lastAppliedY = actualTop;
  }

  function probeStuckContainer(state, container, maxScroll, actualTop) {
    if (
      isRoot(container) ||
      state.animMoved ||
      state.animDirection === 0 ||
      Math.abs(state.lastAppliedY - state.animStartTop) < 2
    ) {
      return false;
    }

    if ((actualTop - state.animStartTop) * state.animDirection >= 0.5) {
      state.animMoved = true;
      return false;
    }

    state.animCheckFrames += 1;

    if (state.animCheckFrames >= 2) {
      state.blockedDir = state.animDirection;
      state.blockedTop = actualTop;
      state.blockedMaxScroll = maxScroll;
      finishState(state, {
        resetVelocity: true
      });
      return true;
    }

    return false;
  }

  function resetKinetics(state) {
    state.inputSpeed = 0;
    state.tauMs = TAU_MAX_MS;
    state.wheelGain = WHEEL_GAIN;
    state.lastWheelTime = 0;
    state.lastWheelDirection = 0;
  }

  function finishState(state, {
    forget = false,
    resetVelocity = false
  } = {}) {
    const container = state.container;

    if (state.raf) {
      cancelAnimationFrame(state.raf);
    }

    activeStates.delete(state);

    state.raf = 0;
    state.lastTime = 0;
    state.animDirection = 0;
    state.animMoved = false;
    state.animCheckFrames = 0;

    if (resetVelocity) resetKinetics(state);

    if (forget && container) {
      states.delete(container);
      state.container = null;
    }

    if (
      INDICATOR_ALLOWED &&
      container &&
      indicator.container === container &&
      !indicator.dragging &&
      !indicator.hovering
    ) {
      if (!container.isConnected) {
        hideIndicator();
      } else {
        scheduleHideIndicator();
      }
    }
  }

  // =========================================================
  // 9. INSTANT SCROLL POSITIONING
  // =========================================================

  function setScrollPositionInstant(container, top) {
    if (supportsInstantBehavior) {
      try {
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
        return;
      } catch {
        supportsInstantBehavior = false;
      }
    }

    if (isRoot(container)) {
      window.scrollTo(window.scrollX, top);
    } else {
      container.scrollTop = top;
    }
  }

  // =========================================================
  // 10. RAF ANIMATION (STRICT READ-THEN-WRITE)
  // =========================================================

  function animate(state, time) {
    const container = state.container;

    if (
      !container ||
      !container.isConnected
    ) {
      finishState(state, {
        forget: true,
        resetVelocity: true
      });
      return;
    }

    const isFirstFrame = state.lastTime === 0;
    const dt = isFirstFrame
      ? 16
      : Math.max(0, Math.min(64, time - state.lastTime));

    state.lastTime = time;

    // --- READ PHASE (single batch, zero read-after-write) ---
    const viewportHeight = getViewportHeight(container);
    const maxScroll = viewportHeight > 0
      ? Math.max(0, container.scrollHeight - viewportHeight)
      : 0;
    const actualTop = getScrollTop(container);

    if (!isFirstFrame && probeStuckContainer(state, container, maxScroll, actualTop)) {
      return;
    }

    reconcileAnchorShift(state, container, maxScroll, actualTop);

    state.targetY = clamp(
      state.targetY,
      0,
      maxScroll
    );

    state.currentY = clamp(
      dampToward(state.currentY, state.targetY, dt, state.tauMs),
      0,
      maxScroll
    );

    // --- WRITE PHASE ---
    if (
      Math.abs(
        state.targetY -
        state.currentY
      ) > EPSILON
    ) {
      setScrollPositionInstant(
        container,
        state.currentY
      );
      state.lastAppliedY = state.currentY;

      if (INDICATOR_ALLOWED) {
        renderIndicator(
          container,
          state.currentY,
          maxScroll,
          viewportHeight
        );
      }

      state.raf = requestAnimationFrame(
        nextTime => animate(state, nextTime)
      );
    } else {
      if (
        !isFirstFrame &&
        !isRoot(container) &&
        !state.animMoved &&
        state.animDirection !== 0 &&
        Math.abs(state.lastAppliedY - state.animStartTop) >= 1 &&
        (actualTop - state.animStartTop) * state.animDirection < 0.5
      ) {
        state.blockedDir = state.animDirection;
        state.blockedTop = actualTop;
        state.blockedMaxScroll = maxScroll;
      }

      setScrollPositionInstant(
        container,
        state.targetY
      );

      state.currentY = state.targetY;
      state.lastAppliedY = state.targetY;

      if (INDICATOR_ALLOWED) {
        renderIndicator(
          container,
          state.targetY,
          maxScroll,
          viewportHeight
        );
      }

      finishState(state);
    }
  }
      // =========================================================
  // 11. WHEEL, POINTER, KEYBOARD & RESIZE HANDLERS
  // =========================================================

  function onWheel(event) {
    if (isIgnoredWheelEvent(event)) return;

    if (INDICATOR_ALLOWED && indicator.dragging) {
      event.preventDefault();
      return;
    }

    const path = getEventPath(event);
    if (hasIgnoredAncestor(path)) return;

    const direction = Math.sign(event.deltaY);
    const selection = findScrollableContainer(getCandidates(path), direction);
    if (!selection) return;

    const { container, viewportHeight, maxScroll, actualTop } = selection;
    const rawDelta = getDelta(event, viewportHeight);
    if (!Number.isFinite(rawDelta) || rawDelta === 0) return;

    const state = getState(container, actualTop);
    state.blockedDir = 0;

    // A reversal is a new gesture, even if the previous RAF already finished.
    if (state.lastWheelDirection !== 0 && state.lastWheelDirection !== direction) {
      resetKinetics(state);
    }
    state.lastWheelDirection = direction;

    if (!state.raf) {
      state.currentY = actualTop;
      state.targetY = actualTop;
      state.lastAppliedY = actualTop;
      state.lastTime = 0;
      state.animStartTop = actualTop;
      state.animDirection = direction;
      state.animMoved = false;
      state.animCheckFrames = 0;
    } else {
      reconcileAnchorShift(state, container, maxScroll, actualTop);
      if (direction !== state.animDirection) {
  // Discard the unfinished target from the previous direction.
  state.targetY = state.currentY;
  state.animStartTop = actualTop;
  state.animDirection = direction;
  state.animMoved = false;
  state.animCheckFrames = 0;
  state.lastAppliedY = actualTop;
}
    }

    const canMove = direction > 0
      ? maxScroll - state.targetY > 0.01
      : state.targetY > 0.01;

    if (!canMove) {
      if (state.raf && Math.abs(state.targetY - state.currentY) <= EPSILON) {
        finishState(state, { resetVelocity: true });
      }
      return;
    }

    updateAdaptiveDamping(state, rawDelta, performance.now());

    const nextTarget = clamp(
      state.targetY + rawDelta * state.wheelGain,
      0,
      maxScroll
    );

    event.preventDefault();
    state.targetY = nextTarget;

    if (INDICATOR_ALLOWED) refreshIndicatorTrack(container);

    if (!state.raf) {
      activeStates.add(state);
      state.raf = requestAnimationFrame(time => animate(state, time));
    }
  }

  function onPointerDown() {
    if (!activeStates.size) {
      return;
    }

    for (const state of [...activeStates]) {
      finishState(state, {
        resetVelocity: true
      });
    }
  }

  function onKeyDown(event) {
    if (!activeStates.size || !NAV_KEYS.has(event.key)) {
      return;
    }

    const target = event.target;
    if (
      target instanceof Element &&
      (target.matches('input, textarea, select, [role="textbox"]') || target.isContentEditable)
    ) {
      return;
    }

    for (const state of [...activeStates]) {
      finishState(state, {
        resetVelocity: true
      });
    }
  }

  function onResize() {
    indicator.lastTrackTime = 0;

    if (
      INDICATOR_ALLOWED &&
      indicator.container &&
      indicator.visible
    ) {
      if (!indicator.container.isConnected) {
        hideIndicator();
        return;
      }

      refreshIndicatorTrack(indicator.container, true);

      const state = states.get(indicator.container);
      const currentY = state && state.raf
        ? state.currentY
        : getScrollTop(indicator.container);

      renderIndicator(
        indicator.container,
        currentY,
        getMaxScroll(indicator.container),
        getViewportHeight(indicator.container)
      );

      if (!indicator.dragging && !indicator.hovering && !(state && state.raf)) {
        scheduleHideIndicator();
      }
    }
  }

  // =========================================================
  // 12. INITIALIZATION
  // =========================================================

  window.addEventListener('wheel', onWheel, {
    passive: false,
    capture: true
  });

  window.addEventListener('pointerdown', onPointerDown, {
    passive: true,
    capture: true
  });

  window.addEventListener('keydown', onKeyDown, {
    passive: true,
    capture: true
  });

  if (INDICATOR_ALLOWED) {
    window.addEventListener('resize', onResize, {
      passive: true
    });
  }

  // =========================================================
  // 13. CLEANUP
  // =========================================================

  function cleanup() {
    window.removeEventListener(
      'wheel',
      onWheel,
      true
    );

    window.removeEventListener(
      'pointerdown',
      onPointerDown,
      true
    );

    window.removeEventListener(
      'keydown',
      onKeyDown,
      true
    );

    if (INDICATOR_ALLOWED) {
      window.removeEventListener(
        'resize',
        onResize
      );
    }

    for (const state of [...activeStates]) {
      finishState(state, {
        forget: true,
        resetVelocity: true
      });
    }

    activeStates.clear();
    destroyIndicator();

    if (window[INSTANCE_KEY] === cleanup) {
      delete window[INSTANCE_KEY];
    }
  }

  window[INSTANCE_KEY] = cleanup;

  console.log(
    `[Po-Fi] Hydraulic Scroll 1.2.24 active. ` +
    `Adaptive τ=${TAU_MIN_MS}-${TAU_MAX_MS}ms. ` +
    `Overlay indicator ${INDICATOR_ALLOWED ? 'enabled' : 'disabled'}.`
  );
})();
