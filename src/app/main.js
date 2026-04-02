/**
 * Main loop orchestration, startup wiring, and frame lifecycle.
 *
 * Runs the fixed-step simulation, coordinates render and collision passes, and
 * wires controls, pointer handlers, presets, and resize behavior into the app.
 *
 * @author Ilya Tsivilskiy
 * @see update
 * @see frame
 * @see spawnPreset
 * @see resolveInterBodyCollisions
 * @see renderBackground
 */

(function () {
  const app = window.Anjellyka;
  const {
    canvas,
    controls,
    state,
    getStageBounds,
    resolveInterBodyCollisions,
    getEffectiveCollisionPasses,
    spawnPreset,
    resetBody,
    clearGrab,
    setMode,
    resizeCanvas,
    syncSettings,
    updateFpsMeter,
    updateStats,
    updateCanvasCursor,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    drawSoftBody,
    drawDraft,
    drawHoverTarget,
    renderBackground,
  } = app;

  /**
   * Advances the full multi-body simulation by one fixed physics step.
   *
   * @param {number} dt Fixed-step duration in seconds.
   */
  function update(dt) {
    if (state.paused || !state.bodies.length) {
      return;
    }

    const bodies = state.bodies;
    const settings = state.settings;
    const bounds = getStageBounds();
    const subDt = dt / settings.substeps;
    const collisionPasses = getEffectiveCollisionPasses(settings, bodies.length);

    for (let substep = 0; substep < settings.substeps; substep += 1) {
      for (let i = 0; i < bodies.length; i += 1) {
        bodies[i].integrate(subDt, settings);
      }

      // Internal shape preservation is solved before inter-body contact so each
      // body first attempts to restore its own structure.
      for (let iteration = 0; iteration < settings.iterations; iteration += 1) {
        for (let i = 0; i < bodies.length; i += 1) {
          const body = bodies[i];
          body.solveDistanceConstraints(settings);
          body.solveAreaConstraint(settings);
          body.collide(bounds, settings);
        }
      }

      if (bodies.length > 1) {
        // Multiple contact passes reduce persistent overlap when several bodies
        // are stacked or compressed together.
        for (let pass = 0; pass < collisionPasses; pass += 1) {
          for (let i = 0; i < bodies.length; i += 1) {
            bodies[i].refreshCollisionCache();
          }

          resolveInterBodyCollisions(bodies);

          for (let i = 0; i < bodies.length; i += 1) {
            bodies[i].collide(bounds, settings);
            bodies[i].refreshCollisionCache();
          }
        }
      }
    }
  }

  /**
   * Browser render-loop callback.
   *
   * @param {number} time High-resolution timestamp from `requestAnimationFrame`.
   */
  function frame(time) {
    resizeCanvas();

    const frameDelta = state.lastFrameTime
      ? Math.max(1 / 1000, (time - state.lastFrameTime) / 1000)
      : state.fixedStep;
    const delta = Math.min(0.033, frameDelta);
    state.lastFrameTime = time;
    updateFpsMeter(frameDelta, time);
    state.accumulator += delta;

    while (state.accumulator >= state.fixedStep) {
      update(state.fixedStep);
      state.accumulator -= state.fixedStep;
    }

    const bounds = getStageBounds();
    renderBackground(bounds);

    for (const body of state.bodies) {
      drawSoftBody(body);
    }

    drawDraft();
    drawHoverTarget();
    requestAnimationFrame(frame);
  }

  Object.values(controls).forEach((element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
      element.addEventListener("input", syncSettings);
      element.addEventListener("change", syncSettings);
    }
  });

  controls.spawnPreset.addEventListener("click", spawnPreset);
  controls.drawMode.addEventListener("click", () =>
    setMode(state.mode === "draw" ? "preset" : "draw")
  );
  controls.removeMode.addEventListener("click", () =>
    setMode(state.mode === "remove" ? "preset" : "remove")
  );
  controls.clearBody.addEventListener("click", () => {
    clearGrab();
    state.pointer.hovering = null;
    state.bodies = [];
    state.bodyFactories = [];
    state.nextColorIndex = 0;
    updateStats();
    updateCanvasCursor();
  });
  controls.togglePause.addEventListener("click", () => {
    state.paused = !state.paused;
    controls.togglePause.textContent = state.paused ? "Resume" : "Pause";
  });
  controls.resetBody.addEventListener("click", resetBody);

  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", handlePointerUp);
  canvas.addEventListener("pointercancel", handlePointerUp);
  canvas.addEventListener("pointerleave", (event) => {
    if (state.pointer.active && state.mode === "draw") {
      handlePointerUp(event);
    }
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  window.addEventListener("resize", () => {
    resizeCanvas();
    updateCanvasCursor();
  });

  Object.assign(app, { update, frame });

  resizeCanvas();
  syncSettings();
  spawnPreset();
  updateCanvasCursor();
  requestAnimationFrame(frame);
})();
