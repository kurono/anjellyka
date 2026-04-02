/**
 * Browser bootstrap, shared namespace initialization, and core application state.
 *
 * Establishes the Anjellyka namespace, captures DOM and WebGL handles, defines
 * shared typedefs, and seeds the mutable state consumed by the rest of the app.
 *
 * @author Ilya Tsivilskiy
 * @see Vec2
 * @see Bounds
 * @see SimulationSettings
 * @see GrabTarget
 * @see window.Anjellyka
 */

/**
 * @typedef {{ x: number, y: number }} Vec2
 * A lightweight 2D point or vector used throughout the simulation.
 */

/**
 * @typedef {{ minX: number, maxX: number, minY: number, maxY: number }} Bounds
 * Axis-aligned bounding box in simulation coordinates.
 */

/**
 * @typedef {{ fill: string, stroke: string }} BodyColor
 * Fill and outline colors assigned to a soft body.
 */

/**
 * @typedef {{ a: number, b: number, stiffness: number, restLength: number }} Constraint
 * Distance constraint connecting two particle indices.
 */

/**
 * @typedef {{
 *   bodySize: number,
 *   spacing: number,
 *   spawnSizeVariation: boolean,
 *   gravityX: number,
 *   gravityY: number,
 *   windX: number,
 *   windY: number,
 *   stiffness: number,
 *   pressure: number,
 *   drag: number,
 *   bounce: number,
 *   wallFriction: number,
 *   iterations: number,
 *   substeps: number,
 *   collisionPasses: number,
 *   showMesh: boolean,
 *   showNodes: boolean
 * }} SimulationSettings
 * User-configurable solver and rendering settings sampled from the control panel.
 */

/**
 * @typedef {{
 *   body: SoftBody,
 *   bodyIndex: number,
 *   pointIndex: number,
 *   point: Point,
 *   gap: number
 * }} GrabTarget
 * Result of the pointer hit-test used for hover and drag interaction.
 */

(function () {
  const app = (window.Anjellyka = window.Anjellyka || {});
  const canvas = document.getElementById("simCanvas");
  const gl =
    canvas.getContext("webgl", {
      alpha: false,
      antialias: true,
      desynchronized: true,
      premultipliedAlpha: true,
    }) || canvas.getContext("experimental-webgl");

  if (!gl) {
    throw new Error("Anjellyka requires a browser with WebGL support.");
  }

  /** Cached DOM references for all GUI controls and readouts. */
  const controls = {
    preset: document.getElementById("preset"),
    bodySize: document.getElementById("bodySize"),
    spacing: document.getElementById("spacing"),
    spawnSizeVariation: document.getElementById("spawnSizeVariation"),
    gravityX: document.getElementById("gravityX"),
    gravityY: document.getElementById("gravityY"),
    windX: document.getElementById("windX"),
    windY: document.getElementById("windY"),
    stiffness: document.getElementById("stiffness"),
    pressure: document.getElementById("pressure"),
    drag: document.getElementById("drag"),
    bounce: document.getElementById("bounce"),
    iterations: document.getElementById("iterations"),
    substeps: document.getElementById("substeps"),
    collisionPasses: document.getElementById("collisionPasses"),
    showMesh: document.getElementById("showMesh"),
    showNodes: document.getElementById("showNodes"),
    spawnPreset: document.getElementById("spawnPreset"),
    drawMode: document.getElementById("drawMode"),
    removeMode: document.getElementById("removeMode"),
    clearBody: document.getElementById("clearBody"),
    togglePause: document.getElementById("togglePause"),
    resetBody: document.getElementById("resetBody"),
    modeHint: document.getElementById("modeHint"),
    stats: document.getElementById("stats"),
    fpsMeter: document.getElementById("fpsMeter"),
  };

  /** Central mutable application state shared by the solver, renderer, and UI. */
  const state = {
    bodies: [],
    bodyFactories: [],
    paused: false,
    mode: "preset",
    accumulator: 0,
    lastFrameTime: 0,
    fixedStep: 1 / 60,
    nextColorIndex: 0,
    performance: {
      fps: 0,
      lastFpsTextTime: 0,
    },
    /** @type {SimulationSettings} */
    settings: {
      bodySize: 150,
      spacing: 22,
      spawnSizeVariation: false,
      gravityX: 0,
      gravityY: 980,
      windX: 0,
      windY: 0,
      stiffness: 0.88,
      pressure: 0.44,
      drag: 0.992,
      bounce: 0.35,
      wallFriction: 0.84,
      iterations: 10,
      substeps: 3,
      collisionPasses: 3,
      showMesh: false,
      showNodes: false,
    },
    pointer: {
      active: false,
      id: null,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      lastMoveTime: 0,
      grabbed: null,
      drawPath: [],
      hovering: null,
    },
  };

  /** Formatting rules used to show human-readable values beside range inputs. */
  const rangeFormatters = {
    bodySize: (value) => `${Math.round(value)} px`,
    spacing: (value) => `${Math.round(value)} px`,
    gravityX: (value) => `${Math.round(value)} px/s²`,
    gravityY: (value) => `${Math.round(value)} px/s²`,
    windX: (value) => `${Math.round(value)} px/s²`,
    windY: (value) => `${Math.round(value)} px/s²`,
    stiffness: (value) => Number(value).toFixed(2),
    pressure: (value) => Number(value).toFixed(2),
    drag: (value) => Number(value).toFixed(3),
    bounce: (value) => Number(value).toFixed(2),
    iterations: (value) => `${Math.round(value)}`,
    substeps: (value) => `${Math.round(value)}`,
    collisionPasses: (value) => `${Math.round(value)}`,
  };

  Object.assign(app, {
    canvas,
    gl,
    controls,
    state,
    rangeFormatters,
  });
})();
