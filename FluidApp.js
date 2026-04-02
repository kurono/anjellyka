/**
 * Main application: config, state, render loop, and toolbar wiring.
 *
 * Domain size L, resolution, time step dt, viscosity nu; orchestrates the time loop
 * (vorticity → advect → pressure → diffuse → pressure → particles).
 *
 * @author Ilya Tsivilskiy
 * @see FluidSolver
 * @see ParticleSolver
 * @see ObstacleManager
 * @see Renderer
 * @see Interaction
 * @see InteractionMode
 */
class FluidApp {
  /** @type {number} Grid resolution (nodes per side). */
  static RES = 80;
  /** @type {number} Domain size [m]. */
  static L = 0.021;
  /** @type {number} Fixed time step [s]. */
  static fixedDt = 8e-4;

  constructor() {
    this.h = FluidApp.L / (FluidApp.RES - 1);
    /** Kinematic viscosity [m²/s]. */
    this.nu = 1.31e-5;
    /** Max Gauss–Seidel iterations for pressure/diffusion. */
    this.maxit = 40;
    /** Vorticity confinement strength. */
    this.vorticityScale = 5;
    this.gridParams = { res: FluidApp.RES, L: FluidApp.L, h: this.h };
    this.fluidParams = {
      grid: this.gridParams,
      res: FluidApp.RES,
      L: FluidApp.L,
      h: this.h,
      nu: this.nu,
      maxit: this.maxit,
      vorticityScale: this.vorticityScale,
      bc: null
    };
    this.particleParams = {
      grid: this.gridParams,
      particles: {
        nu: this.nu,
        rho: 1.2,
        mu: 1.8e-5,
        dp: 1e-4,
        rhop: 1000,
        gx: 0,
        gy: -9.8 * 0.01,
        pVelDamp: 0.2
      },
      solidNormal: { snx: null, sny: null }
    };
    this.canvas = document.getElementById('canvas');
    this.fluidState = FluidSolver.createFluidState(FluidApp.RES, FluidApp.L);
    this.particles = ParticleSolver.createParticles();
    this.renderer = new Renderer(this.canvas, FluidApp.L);
    this.fpsMeter = new FPSMeter(30);
    /** Set true when user draws/erases/resets obstacles so contour is rebuilt once. */
    this.obstaclesDirty = false;
    this.interaction = new Interaction(
      this.canvas,
      this.renderer,
      { fluidState: this.fluidState, particles: this.particles },
      { grid: this.gridParams, onObstaclesChanged: () => { this.obstaclesDirty = true; } }
    );
    this.lastTime = 0;
    /** Simulation time [s] (physical time of the fluid state). */
    this.simTime = 0;
    /** Accumulated time for fixed-step integration */
    this.accumulated = 0;
    this.maxAccumulated = FluidApp.fixedDt * 4;
    /** Clamp BC velocities to CFL-friendly max (0.5 cell per step) */
    this.maxBCVel = 0.5 * this.h / FluidApp.fixedDt;
    /** Fluid step count for colormap limit update interval */
    this.fluidStepCount = 0;
    /** Velocity magnitude scale for colormap; recomputed every 10 fluid steps */
    this.colormapMaxMag = 0.01;
  }

  /**
   * Reads boundary-condition config from the UI (velocity per edge, zero-gradient flags).
   * @returns {{ top: Object, bottom: Object, left: Object, right: Object }} BC config per side
   */
  getBCConfig() {
    const maxV = this.maxBCVel;
    const num = (id) => {
      const el = document.getElementById(id);
      const v = el ? parseFloat(el.value) || 0 : 0;
      return Math.max(-maxV, Math.min(maxV, v));
    };
    const zgrad = (id) => {
      const el = document.getElementById(id);
      return el ? el.checked : false;
    };
    // Each side: ux, uy, and optional zero-gradient (copy from interior)
    return {
      top: { ux: num('bc-top-ux'), uy: num('bc-top-uy'), zeroGrad: zgrad('bc-top-zerograd') },
      bottom: { ux: num('bc-bottom-ux'), uy: num('bc-bottom-uy'), zeroGrad: zgrad('bc-bottom-zerograd') },
      left: { ux: num('bc-left-ux'), uy: num('bc-left-uy'), zeroGrad: zgrad('bc-left-zerograd') },
      right: { ux: num('bc-right-ux'), uy: num('bc-right-uy'), zeroGrad: zgrad('bc-right-zerograd') }
    };
  }

  /**
   * Resizes the canvas to match display size and device pixel ratio.
   */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
  }

  /**
   * Full reset: fluid fields to zero, clear particles, clear obstacles, reset boundary conditions to zero.
   */
  reset() {
    this.fluidState.Ux.fill(0);
    this.fluidState.Uy.fill(0);
    this.fluidState.P.fill(0);
    this.fluidState.solid.fill(0);
    this.obstaclesDirty = true;
    this.particles.x.length = 0;
    this.particles.y.length = 0;
    this.particles.vx.length = 0;
    this.particles.vy.length = 0;
    this.accumulated = 0;
    this.simTime = 0;
    this.fluidStepCount = 0;
    this.colormapMaxMag = 0.01;
    this.#updateTimeAndColorbar();
    const bcSides = ['top', 'bottom', 'left', 'right'];
    bcSides.forEach((side) => {
      const uxEl = document.getElementById(`bc-${side}-ux`);
      const uyEl = document.getElementById(`bc-${side}-uy`);
      const zgradEl = document.getElementById(`bc-${side}-zerograd`);
      if (uxEl) { uxEl.value = '0'; this.#formatBcInput(uxEl); }
      if (uyEl) { uyEl.value = '0'; this.#formatBcInput(uyEl); }
      if (zgradEl) zgradEl.checked = false;
      this.#updateZeroGradVisual(`bc-${side}`, `bc-${side}-zerograd`);
    });
  }

  /**
   * Clears the obstacle mask (all cells set to fluid).
   */
  resetObstacles() {
    this.fluidState.solid.fill(0);
    this.obstaclesDirty = true;
  }

  /**
   * Main animation loop: fixed timestep fluid + particles, then render.
   * Order: add forces → advect → pressure → diffuse → pressure → particles.
   * @param {number} t - High-res timestamp from requestAnimationFrame
   */
  #loop = (t) => {
    requestAnimationFrame(this.#loop);
    this.fpsMeter.tick(t);
    const delta = (t - this.lastTime) / 1000 || 0.016;
    this.lastTime = t;
    this.accumulated = Math.min(this.accumulated + delta, this.maxAccumulated);
    let stepsThisFrame = 0;
    let doRender = false;
    while (this.accumulated >= FluidApp.fixedDt) {
      this.fluidParams.bc = this.getBCConfig();
      this.particleParams.solidNormal = ObstacleManager.getSolidNormals(this.fluidState.solid, this.h, FluidApp.RES);
      const next = FluidSolver.stepFluid(
        {
          Ux: this.fluidState.Ux,
          Uy: this.fluidState.Uy,
          P: this.fluidState.P,
          solid: this.fluidState.solid
        },
        FluidApp.fixedDt,
        this.fluidParams
      );
      this.fluidState.Ux.set(next.Ux);
      this.fluidState.Uy.set(next.Uy);
      this.fluidState.P.set(next.P);
      ParticleSolver.stepParticles(this.particles, this.fluidState, this.particleParams, FluidApp.fixedDt);
      this.accumulated -= FluidApp.fixedDt;
      this.simTime += FluidApp.fixedDt;
      this.fluidStepCount++;
      stepsThisFrame++;
      doRender = true;
      if (this.fluidStepCount % 10 === 0) {
        const maxU = FluidSolver.getMaxFluidVelocity(
          this.fluidState.Ux, this.fluidState.Uy, this.fluidState.solid, FluidApp.RES
        );
        this.colormapMaxMag = Math.max(0.01, maxU);
      }
    }
    if (doRender || stepsThisFrame === 0) {
      const upsample = document.getElementById('opt-upsample')?.checked ? 2 : 1;
      this.renderer.render(this.fluidState, this.particles, FluidApp.RES, this.h, this.colormapMaxMag, {
        obstaclesDirty: this.obstaclesDirty,
        upsample
      });
      this.obstaclesDirty = false;
      this.#updateTimeAndColorbar();
    }
  };

  /**
   * Updates the simulation time display and colorbar tick labels.
   */
  #updateTimeAndColorbar() {
    const timeEl = document.getElementById('sim-time');
    const fps = Math.round(this.fpsMeter.getFPS());
    if (timeEl) timeEl.textContent = `t = ${this.simTime.toFixed(3)} [s]  |  ${fps} FPS`;
    const maxMag = this.colormapMaxMag;
    const fmt = (v) => (v < 0.01 || v >= 100 ? v.toExponential(2) : v.toFixed(3));
    const tickIds = ['colorbar-tick-0', 'colorbar-tick-1', 'colorbar-tick-2', 'colorbar-tick-3', 'colorbar-tick-max'];
    const values = [0, 0.25 * maxMag, 0.5 * maxMag, 0.75 * maxMag, maxMag];
    tickIds.forEach((id, i) => {
      const el = document.getElementById(id);
      if (el) el.textContent = fmt(values[i]);
    });
  }

  /**
   * Sets the active interaction mode and updates toolbar active state.
   * @param {string} mode - One of InteractionMode.OBSTACLE | ERASER | VELOCITY | PARTICLES
   */
  #setActiveMode(mode) {
    this.interaction.setMode(mode);
    document.querySelectorAll('.toolbar button').forEach((btn) => btn.classList.remove('active'));
    const idMap = {
      [InteractionMode.OBSTACLE]: 'mode-obstacle',
      [InteractionMode.ERASER]: 'mode-eraser',
      [InteractionMode.VELOCITY]: 'mode-velocity',
      [InteractionMode.PARTICLES]: 'mode-particles'
    };
    const id = idMap[mode];
    if (id) document.getElementById(id).classList.add('active');
  }

  /**
   * Toggles UI state for zero-gradient BC: disables ux/uy inputs when zero-grad is checked.
   * @param {string} panelId - ID of the BC panel (e.g. 'bc-top')
   * @param {string} checkboxId - ID of the zero-gradient checkbox
   */
  #updateZeroGradVisual(panelId, checkboxId) {
    const panel = document.getElementById(panelId);
    const checkbox = document.getElementById(checkboxId);
    if (!panel || !checkbox) return;
    const checked = checkbox.checked;
    panel.classList.toggle('zero-grad-active', checked);
    const side = panelId.replace('bc-', '');
    const uxEl = document.getElementById(`bc-${side}-ux`);
    const uyEl = document.getElementById(`bc-${side}-uy`);
    if (uxEl) uxEl.disabled = checked;
    if (uyEl) uyEl.disabled = checked;
  }

  /**
   * Format a BC number input to X.XX and clamp to allowed range.
   * @param {HTMLInputElement} el - Input element
   */
  #formatBcInput(el) {
    if (!el) return;
    const maxV = this.maxBCVel;
    let v = parseFloat(el.value);
    if (Number.isNaN(v)) v = 0;
    v = Math.max(-maxV, Math.min(maxV, v));
    el.value = v.toFixed(2);
  }

  /**
   * Starts the app: resize handler, BC UI setup, toolbar mode buttons, reset buttons, and loop.
   */
  start() {
    window.addEventListener('resize', () => this.resize());
    this.resize();
    const bcSides = ['top', 'bottom', 'left', 'right'];
    const maxV = this.maxBCVel;
    bcSides.forEach((side) => {
      const panelId = `bc-${side}`;
      const checkboxId = `bc-${side}-zerograd`;
      ['ux', 'uy'].forEach((comp) => {
        const el = document.getElementById(`bc-${side}-${comp}`);
        if (el) {
          el.min = String(-maxV);
          el.max = String(maxV);
          el.addEventListener('blur', () => this.#formatBcInput(el));
        }
      });
      this.#updateZeroGradVisual(panelId, checkboxId);
      document.getElementById(checkboxId).addEventListener('change', () => {
        this.#updateZeroGradVisual(panelId, checkboxId);
      });
    });
    document.getElementById('mode-obstacle').addEventListener('click', () => this.#setActiveMode(InteractionMode.OBSTACLE));
    document.getElementById('mode-eraser').addEventListener('click', () => this.#setActiveMode(InteractionMode.ERASER));
    document.getElementById('mode-velocity').addEventListener('click', () => this.#setActiveMode(InteractionMode.VELOCITY));
    document.getElementById('mode-particles').addEventListener('click', () => this.#setActiveMode(InteractionMode.PARTICLES));
    document.getElementById('btn-reset').addEventListener('click', () => this.reset());
    document.getElementById('btn-reset-obstacles').addEventListener('click', () => this.resetObstacles());
    requestAnimationFrame(this.#loop);
  }
}
