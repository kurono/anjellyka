/**
 * Scene mutations, preset spawning, and stage-space body management.
 *
 * Computes spawn anchors, builds preset outlines, stores rebuild factories, and
 * manages add, remove, spawn, and reset flows for soft bodies in the scene.
 *
 * @author Ilya Tsivilskiy
 * @see getStageBounds
 * @see buildPresetPolygon
 * @see createBodyFactoryFromPolygon
 * @see addBody
 * @see resetBody
 */

(function () {
  const app = window.Anjellyka;
  const {
    canvas,
    controls,
    state,
    clamp,
    clonePolygon,
    lerp,
    takeNextBodyColor,
    buildSoftBodyFromPolygon,
    makeCirclePolygon,
    makeBoxPolygon,
    makeCapsulePolygon,
    makeStarPolygon,
    makeHeartPolygon,
    clearGrab,
    updateStats,
    updateCanvasCursor,
  } = app;

  /**
   * Returns the logical canvas bounds in CSS pixels.
   *
   * @returns {{ width: number, height: number }}
   */
  function getStageBounds() {
    const scale = window.devicePixelRatio || 1;
    return {
      width: canvas.width / scale,
      height: canvas.height / scale,
    };
  }

  /**
   * Chooses a spawn location for the next preset body.
   *
   * @param {{ width: number, height: number }} bounds
   * @param {number} slot Sequential spawn index.
   * @param {number} size Representative body size.
   * @returns {Vec2}
   */
  function getPresetSpawnAnchor(bounds, slot, size) {
    const columns = Math.max(1, Math.min(4, Math.floor(bounds.width / Math.max(size * 1.9, 180))));
    const normalizedSlot = columns > 0 ? slot % (columns * 3) : 0;
    const column = normalizedSlot % columns;
    const row = Math.floor(normalizedSlot / columns);
    const x =
      columns === 1
        ? bounds.width * 0.5
        : lerp(size, bounds.width - size, column / Math.max(1, columns - 1));
    const y = clamp(size * 1.1 + row * size * 1.35, size, bounds.height * 0.46);
    return { x, y };
  }

  /**
   * Builds the currently selected preset polygon using the active UI controls.
   *
   * @param {number} [slot=state.bodyFactories.length] Sequential spawn index.
   * @returns {Vec2[]}
   */
  function buildPresetPolygon(slot = state.bodyFactories.length) {
    const bounds = getStageBounds();
    const sizeMultiplier = state.settings.spawnSizeVariation ? lerp(0.8, 1.2, Math.random()) : 1;
    const maxSize = Math.min(state.settings.bodySize * 1.2, bounds.width * 0.28, bounds.height * 0.32);
    const size = clamp(state.settings.bodySize * sizeMultiplier, 60, maxSize);
    const anchor = getPresetSpawnAnchor(bounds, slot, size);
    const cx = anchor.x;
    const cy = anchor.y;

    switch (controls.preset.value) {
      case "box":
        return makeBoxPolygon(cx, cy, size * 1.4, size);
      case "capsule":
        return makeCapsulePolygon(cx, cy, size * 1.8, size * 0.85);
      case "star":
        return makeStarPolygon(cx, cy, size, size * 0.54);
      case "heart":
        return makeHeartPolygon(cx, cy, size * 0.95, 42);
      case "circle":
      default:
        return makeCirclePolygon(cx, cy, size * 0.72, 20);
    }
  }

  /**
   * Creates a replayable factory for rebuilding a body from a stored polygon.
   *
   * @param {Vec2[]} polygon
   * @param {number} spacing
   * @param {BodyColor} [color=takeNextBodyColor()]
   * @returns {() => SoftBody | null}
   */
  function createBodyFactoryFromPolygon(polygon, spacing, color = takeNextBodyColor()) {
    const storedPolygon = clonePolygon(polygon);
    return () => buildSoftBodyFromPolygon(clonePolygon(storedPolygon), spacing, color);
  }

  /**
   * Instantiates a body from a factory and appends it to the scene.
   *
   * @param {() => SoftBody | null} factory
   */
  function addBody(factory) {
    const body = factory();
    if (!body) {
      return;
    }

    clearGrab();
    state.pointer.hovering = null;
    state.bodyFactories.push(factory);
    state.bodies.push(body);
    updateStats();
    updateCanvasCursor();
  }

  /**
   * Permanently removes a body from the scene and from the stored reset list.
   *
   * @param {number} bodyIndex
   */
  function removeBody(bodyIndex) {
    if (bodyIndex < 0 || bodyIndex >= state.bodies.length) {
      return;
    }

    const body = state.bodies[bodyIndex];
    if (state.pointer.grabbed && state.pointer.grabbed.body === body) {
      clearGrab();
    }

    state.pointer.hovering = null;
    state.bodies.splice(bodyIndex, 1);
    state.bodyFactories.splice(bodyIndex, 1);
    updateStats();
    updateCanvasCursor();
  }

  /**
   * Creates and appends one body from the currently selected preset.
   */
  function spawnPreset() {
    const polygon = buildPresetPolygon();
    addBody(createBodyFactoryFromPolygon(polygon, state.settings.spacing));
  }

  /**
   * Rebuilds all bodies from their stored factories.
   */
  function resetBody() {
    clearGrab();
    state.pointer.hovering = null;
    state.bodies = state.bodyFactories.map((factory) => factory()).filter(Boolean);
    updateStats();
    updateCanvasCursor();
  }

  Object.assign(app, {
    getStageBounds,
    getPresetSpawnAnchor,
    buildPresetPolygon,
    createBodyFactoryFromPolygon,
    addBody,
    removeBody,
    spawnPreset,
    resetBody,
  });
})();
