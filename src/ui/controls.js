/**
 * Control-panel synchronization, HUD updates, and shared UI state transitions.
 *
 * Maps DOM inputs into simulation settings, manages mode switches and cursor
 * state, and updates stats, outputs, resize behavior, and FPS readouts.
 *
 * @author Ilya Tsivilskiy
 * @see clearGrab
 * @see setMode
 * @see syncSettings
 * @see updateStats
 * @see updateCanvasCursor
 */

(function () {
  const app = window.Anjellyka;
  const { canvas, gl, controls, state, rangeFormatters, lerp } = app;

  /**
   * Releases the currently grabbed particle and restores its Verlet history so it
   * leaves the pointer with inherited momentum.
   */
  function clearGrab() {
    const grabbed = state.pointer.grabbed;
    if (!grabbed) {
      return;
    }

    grabbed.point.pinned = false;
    grabbed.point.oldX = grabbed.point.x - state.pointer.vx * state.fixedStep;
    grabbed.point.oldY = grabbed.point.y - state.pointer.vy * state.fixedStep;
    state.pointer.grabbed = null;
  }

  /**
   * Switches between preset-spawn, freehand drawing, and body-removal modes.
   *
   * @param {"preset" | "draw" | "remove"} mode
   */
  function setMode(mode) {
    if (mode === state.mode) {
      return;
    }

    state.mode = mode;
    state.pointer.drawPath = [];
    state.pointer.hovering = null;
    clearGrab();
    controls.drawMode.classList.toggle("active", mode === "draw");
    controls.removeMode.classList.toggle("active", mode === "remove");

    if (mode === "draw") {
      controls.modeHint.textContent =
        "Draw mode: press and sketch a closed loop to append a new body.";
    } else if (mode === "remove") {
      controls.modeHint.textContent =
        "Remove mode: tap or click inside a body on the canvas to delete it permanently.";
    } else {
      controls.modeHint.textContent =
        "Preset mode: drag any body with mouse or touch. Each spawn appends a new body.";
    }

    updateCanvasCursor();
  }

  /**
   * Resizes the canvas backing store to match the displayed element size and the
   * current device-pixel ratio.
   *
   * @returns {boolean} Whether the canvas dimensions changed.
   */
  function resizeCanvas() {
    const scale = window.devicePixelRatio || 1;
    const cssWidth = Math.max(1, canvas.clientWidth || canvas.offsetWidth || 0);
    const cssHeight = Math.max(1, canvas.clientHeight || canvas.offsetHeight || 0);
    const width = Math.max(1, Math.round(cssWidth * scale));
    const height = Math.max(1, Math.round(cssHeight * scale));

    if (canvas.width === width && canvas.height === height) {
      return false;
    }

    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
    return true;
  }

  /**
   * Refreshes all numeric readouts beside the GUI sliders.
   */
  function updateOutputs() {
    Object.entries(rangeFormatters).forEach(([key, formatter]) => {
      const input = controls[key];
      if (!input) {
        return;
      }

      const output = document.querySelector(`output[for="${input.id}"]`);
      if (output) {
        output.textContent = formatter(input.value);
      }
    });
  }

  /**
   * Pulls the latest settings from the DOM into application state.
   */
  function syncSettings() {
    state.settings.bodySize = Number(controls.bodySize.value);
    state.settings.spacing = Number(controls.spacing.value);
    state.settings.spawnSizeVariation = controls.spawnSizeVariation.checked;
    state.settings.gravityX = Number(controls.gravityX.value);
    state.settings.gravityY = Number(controls.gravityY.value);
    state.settings.windX = Number(controls.windX.value);
    state.settings.windY = Number(controls.windY.value);
    state.settings.stiffness = Number(controls.stiffness.value);
    state.settings.pressure = Number(controls.pressure.value);
    state.settings.drag = Number(controls.drag.value);
    state.settings.bounce = Number(controls.bounce.value);
    state.settings.iterations = Number(controls.iterations.value);
    state.settings.substeps = Number(controls.substeps.value);
    state.settings.collisionPasses = Number(controls.collisionPasses.value);
    state.settings.showMesh = controls.showMesh.checked;
    state.settings.showNodes = controls.showNodes.checked;
    updateOutputs();
    updateStats();
  }

  /**
   * Updates the body/particle/constraint summary text in the side panel.
   */
  function updateStats() {
    if (!state.bodies.length) {
      controls.stats.textContent = "No bodies loaded.";
      return;
    }

    const totalPoints = state.bodies.reduce((sum, body) => sum + body.points.length, 0);
    const totalConstraints = state.bodies.reduce((sum, body) => sum + body.constraints.length, 0);

    controls.stats.textContent =
      `${state.bodies.length} bodies, ` +
      `${totalPoints} points, ` +
      `${totalConstraints} constraints`;
  }

  /**
   * Updates the FPS readout using an exponentially smoothed frame-rate estimate.
   *
   * @param {number} frameDelta Render-frame duration in seconds.
   * @param {number} now Current `requestAnimationFrame` timestamp in milliseconds.
   */
  function updateFpsMeter(frameDelta, now) {
    if (!controls.fpsMeter) {
      return;
    }

    const instantFps = frameDelta > 0 ? 1 / frameDelta : 0;
    const performanceState = state.performance;

    performanceState.fps = performanceState.fps
      ? lerp(performanceState.fps, instantFps, 0.14)
      : instantFps;

    if (now - performanceState.lastFpsTextTime < 120) {
      return;
    }

    performanceState.lastFpsTextTime = now;
    controls.fpsMeter.textContent = `FPS ${performanceState.fps.toFixed(1)}`;
  }

  /**
   * Chooses the canvas cursor based on the current interaction state.
   */
  function updateCanvasCursor() {
    if (state.mode === "draw" || state.mode === "remove") {
      canvas.style.cursor = "crosshair";
      return;
    }

    if (state.pointer.grabbed) {
      canvas.style.cursor = "grabbing";
      return;
    }

    if (state.pointer.hovering) {
      canvas.style.cursor = "grab";
      return;
    }

    canvas.style.cursor = "default";
  }

  Object.assign(app, {
    clearGrab,
    setMode,
    resizeCanvas,
    updateOutputs,
    syncSettings,
    updateStats,
    updateFpsMeter,
    updateCanvasCursor,
  });
})();
