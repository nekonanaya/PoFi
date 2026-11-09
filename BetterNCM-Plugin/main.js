(() => {
  'use strict';

  // Po-Fi Hydraulic Scroll for BetterNCM
  // Version 1.2.2
  //
  // Adaptive hydraulic damping:
  // - Slow input: lighter damping
  // - Fast input: stronger damping
  //
  // Engine baseline: BetterNCM / NCM 2.10.13
  // RAF runs only while scrolling is active.

  // =========================================================
  // 1. USER CONFIGURATION
  // =========================================================

  const CONFIG = Object.freeze({
    // Overall wheel travel multiplier.
    // 1.00 = original wheel distance.
    // 0.90 = shorter travel.
    // 1.10 = longer travel.
    WHEEL_GAIN: 1.00,

    // Adaptive damping range.
    // Higher values produce more damping and a longer settling time.
    TAU_MIN_MS: 34,
    TAU_MAX_MS: 68,

    // Input velocity at which adaptive damping approaches its maximum.
    // Unit: CSS pixels per millisecond.
    SPEED_REFERENCE_PX_PER_MS: 2.6,

    // Smooth input-velocity filtering.
    SPEED_FILTER_MS: 100,

    // Reset velocity history after a sufficiently long idle period.
    SPEED_RESET_MS: 220,

    LINE_SIZE: 40,
    EPSILON: 0.5,

    // Prevent a long suspended frame from producing a large jump.
    MAX_FRAME_DT_MS: 32
  });

  const INSTANCE_KEY = '__POFI_BETTERNCM_SCROLL__';

  const states = new WeakMap();
  const activeStates = new Set();

  // =========================================================
  // 2. INSTANCE CLEANUP
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
        // Preserve native playback-page lyric scrolling.
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
      return event.deltaY * CONFIG.LINE_SIZE;
    }

    if (event.deltaMode === 2) {
      return event.deltaY *
        (container.clientHeight || window.innerHeight);
    }

    return event.deltaY;
  }

  // =========================================================
  // 5. SCROLL CONTAINER SELECTION
  // =========================================================

  function findScrollableContainer(candidates, direction) {
    for (const container of candidates) {
      if (!container || !container.isConnected) {
        continue;
      }

      const root = isRoot(container);

      const maxScroll = getMaxScroll(container);

      if (maxScroll <= 1) {
        continue;
      }

      const style = getComputedStyle(container);

      // The document root may report overflowY: visible.
      if (
        !root &&
        !/^(auto|scroll|overlay)$/.test(style.overflowY)
      ) {
        continue;
      }

      const state = states.get(container);

      const current =
        state && state.raf
          ? state.targetY
          : container.scrollTop;

      const canScrollDown =
        direction > 0 &&
        maxScroll - current > CONFIG.EPSILON;

      const canScrollUp =
        direction < 0 &&
        current > CONFIG.EPSILON;

      if (canScrollDown || canScrollUp) {
        if (style.scrollSnapType !== 'none') {
          return null;
        }

        return {
          container,
          maxScroll
        };
      }

      const overscroll = style.overscrollBehaviorY;

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
  // 6. ADAPTIVE DAMPING
  // =========================================================

  function getAdaptiveTau(inputSpeed) {
    const normalized = clamp(
      inputSpeed /
        CONFIG.SPEED_REFERENCE_PX_PER_MS,
      0,
      1
    );

    // Smoothstep: continuous acceleration of damping strength.
    const curve =
      normalized * normalized *
      (3 - 2 * normalized);

    return CONFIG.TAU_MIN_MS +
      (
        CONFIG.TAU_MAX_MS -
        CONFIG.TAU_MIN_MS
      ) * curve;
  }

  function updateAdaptiveDamping(state, delta, now) {
    let elapsed = state.lastWheelTime
      ? now - state.lastWheelTime
      : 16;

    // A long pause starts a new, light input sequence.
    if (elapsed > CONFIG.SPEED_RESET_MS) {
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
        -filterDt / CONFIG.SPEED_FILTER_MS
      );

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
  // 7. STATE MANAGEMENT
  // =========================================================

  function getState(container, maxScroll) {
    let state = states.get(container);

    if (!state) {
      const current = container.scrollTop;

      state = {
        container,

        currentY: current,
        targetY: current,

        // Geometry is cached and refreshed on wheel input.
        maxScroll,

        // Adaptive damping state.
        inputSpeed: 0,
        tauMs: 45,
        lastWheelTime: 0,

        lastTime: 0,
        raf: 0
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

  // =========================================================
  // 9. RAF ANIMATION
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

    // The currently scheduled frame has been consumed.
    state.raf = 0;

    const dt = state.lastTime
      ? Math.max(
          0,
          Math.min(
            CONFIG.MAX_FRAME_DT_MS,
            time - state.lastTime
          )
        )
      : 16;

    state.lastTime = time;

    // No layout measurement here.
    // maxScroll is refreshed by wheel input instead.
    const maxScroll = state.maxScroll;

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
      ) > CONFIG.EPSILON
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
  // 10. WHEEL HANDLER
  // =========================================================

  function onWheel(event) {
    const {
      path,
      candidates
    } = getCandidates(event);

    if (shouldIgnore(event, path)) {
      return;
    }

    const selection = findScrollableContainer(
      candidates,
      Math.sign(event.deltaY)
    );

    if (!selection) {
      return;
    }

    const {
      container,
      maxScroll
    } = selection;

    const delta =
      getDelta(event, container) *
      CONFIG.WHEEL_GAIN;

    if (
      !Number.isFinite(delta) ||
      delta === 0
    ) {
      return;
    }

    const state = getState(
      container,
      maxScroll
    );

    if (!state.raf) {
      state.currentY = container.scrollTop;
      state.targetY = container.scrollTop;
      state.lastTime = 0;
    }

    // Update cached geometry once per accepted wheel event.
    state.maxScroll = maxScroll;

    updateAdaptiveDamping(
      state,
      delta,
      performance.now()
    );

    const nextTarget = clamp(
      state.targetY + delta,
      0,
      state.maxScroll
    );

    if (
      Math.abs(
        nextTarget - state.targetY
      ) < 0.01
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

  // =========================================================
  // 11. INITIALIZATION
  // =========================================================

  window.addEventListener(
    'wheel',
    onWheel,
    {
      passive: false,
      capture: true
    }
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

  console.info(
    `[Po-Fi] BetterNCM 1.2.2 loaded. ` +
    `Adaptive τ=${CONFIG.TAU_MIN_MS}-` +
    `${CONFIG.TAU_MAX_MS}ms. ` +
    `Instant positioning enabled.`
  );
})();
