# Anjellyka

**Author:** Ilya Tsivilskiy

![Anjellyka demo](assets/anim.gif)

Anjellyka is a derivation from "jelly" material physics and Kinematics, presented as a serverless browser playground for 2D soft-body motion. It runs entirely in HTML, CSS, and vanilla JavaScript using a `<canvas>` element with a WebGL-backed renderer. No backend, build step, or external physics engine is required.

The app lets you:

- spawn preset shapes such as circles, boxes, capsules, and stars,
- draw arbitrary closed loops directly on the canvas,
- simulate multiple deformable bodies at once,
- interact with them by grabbing and dragging particles,
- tune solver parameters such as gravity, wind, damping, stiffness, iterations, and collision passes.

This document explains the mathematics, the numerical methods, and how the implementation in the `src/` script pipeline works.

## Source File Structure

The app is split into small browser scripts under `src/` and loaded in `index.html` through classic `<script>` tags. Each file extends the shared `window.Anjellyka` namespace, so load order matters.

```Shell
src/
  app/
    main.js          fixed-step simulation loop and app wiring
    scene.js         body spawning, reset logic, and stage bounds helpers
  bodies/
    factory.js       polygon-to-soft-body conversion and preset polygon builders
  core/
    bootstrap.js     canvas lookup, WebGL context creation, DOM references, shared state
  math/
    geometry.js      vector, polygon, triangulation, and color helper utilities
  physics/
    collisions.js    inter-body collision detection and geometric resolution
    point.js         Verlet particle primitive
    soft-body.js     deformable body representation and solver stages
  render/
    canvas.js        WebGL shader setup and all draw passes
  ui/
    controls.js      GUI synchronization, resize handling, FPS/stats updates
    interaction.js   pointer hit testing, dragging, drawing, and removal tools
```

At a high level, the runtime is organized like this:

- `src/core/bootstrap.js` creates the shared app namespace and initializes the WebGL canvas context plus mutable state.
- `src/math/geometry.js` provides the low-level primitives used by both physics and rendering.
- `src/physics/*.js` defines particles, soft bodies, and multi-body collision resolution.
- `src/bodies/factory.js` converts polygons into particle-and-constraint graphs and exposes the preset shape builders.
- `src/ui/*.js` owns DOM synchronization and pointer interaction.
- `src/app/scene.js` manages scene-level body creation and stored reset factories.
- `src/render/canvas.js` turns the current simulation state into WebGL draw calls.
- `src/app/main.js` drives the fixed-step update loop and connects the UI, scene, physics, and renderer together.

## 1. Simulation Model

Each soft body is represented as a collection of particles connected by distance constraints.

- Boundary particles define the visible outline.
- Interior particles help resist collapse and improve shape stability.
- Constraints connect nearby particles and attempt to preserve their rest lengths.
- A global area constraint approximately preserves the enclosed volume in 2D.

This is a particle-based deformable body model rather than a continuum finite-element model. It is simpler, robust in interactive applications, and well suited for real-time browser rendering.

## 2. State Variables

For each particle $i$, the simulation stores:

- current position: $\mathbf{x}_i^n$,
- previous position: $\mathbf{x}_i^{n-1}$,
- collision radius: $r_i$,
- optional pinning state for user interaction.

Because the method uses Verlet integration, velocity is not stored explicitly. Instead, it is reconstructed from the current and previous positions:

$$
\mathbf{v}_i^n \approx \mathbf{x}_i^n - \mathbf{x}_i^{n-1}
$$

This is one of the main reasons Verlet integration is attractive for constraint-based soft bodies: positions are primary, and constraints can be applied directly to them.

## 3. External Forces

The app currently exposes gravity and wind-like acceleration controls. The total acceleration applied to a free particle is:

$$
\mathbf{a} =
\begin{bmatrix}
g_x + w_x \\
g_y + w_y
\end{bmatrix}
$$

where:

- $g_x, g_y$ are the gravity controls,
- $w_x, w_y$ are the wind controls.

These are treated as uniform accelerations applied to all non-pinned particles.

## 4. Verlet Integration

The particle update uses damped Verlet integration. In standard position Verlet form:

$$
\mathbf{x}_i^{n+1} = \mathbf{x}_i^n + (\mathbf{x}_i^n - \mathbf{x}_i^{n-1}) + \mathbf{a}\,\Delta t^2
$$

The implementation adds damping to the inferred velocity term:

$$
\mathbf{v}_i^n = d \, (\mathbf{x}_i^n - \mathbf{x}_i^{n-1})
$$

$$
\mathbf{x}_i^{n+1} = \mathbf{x}_i^n + \mathbf{v}_i^n + \mathbf{a}\,\Delta t^2
$$

where $d \in (0,1)$ is the damping factor exposed by the UI.

In `src/physics/soft-body.js`, this is done in `SoftBody.integrate()`:

1. reconstruct the velocity from current and previous positions,
2. multiply by damping,
3. clamp the speed for stability,
4. advance the particle using acceleration times $\Delta t^2$.

### Why this works well here

Verlet integration is especially useful for soft-body solvers because:

- it is simple,
- it is stable for interactive time steps,
- constraints can be projected directly onto particle positions,
- collisions can be resolved geometrically by correcting positions.

## 5. Distance Constraints

Each constraint connects particles $a$ and $b$ and stores a rest length $L_0$.

Define:

$$
\mathbf{d} = \mathbf{x}_b - \mathbf{x}_a
$$

$$
L = \|\mathbf{d}\|
$$

The normalized constraint error is:

$$
e = \frac{L - L_0}{L}
$$

The correction direction is along the segment $\mathbf{d}$. A stiffness factor $k$ scales how aggressively the solver attempts to restore the rest length:

$$
\Delta \mathbf{x} = k \, e \, \mathbf{d}
$$

The correction is then split between the two particles according to whether they are movable or pinned.

This is a standard position-based dynamics style projection step. Instead of integrating spring forces explicitly, the solver directly adjusts positions to satisfy the geometric constraint.

### Why iterative projection is used

All constraints cannot be satisfied exactly in one pass. Instead, the solver performs several iterations:

$$
\text{for iteration } = 1 \dots N:
\quad \text{project each constraint}
$$

Increasing the iteration count improves rigidity and reduces visible stretch, but it costs more CPU time.

## 6. Area Preservation and Pressure

Distance constraints alone often allow the body to collapse or wrinkle too much. To resist this, the simulation applies an area-preservation constraint to each body's boundary polygon.

For a polygon with vertices $(x_i, y_i)$, the signed area is computed using the shoelace formula:

$$
A = \frac{1}{2}\sum_{i=0}^{n-1} (x_i y_{i+1} - y_i x_{i+1})
$$

The body stores a target area $A_0$ measured from the rest configuration. During simulation, the current area $A$ is compared to $A_0$, and a correction magnitude is computed:

$$
\lambda = \mathrm{clamp}\left(\frac{A_0 - A}{\sum_i \|\nabla_i A\|^2} \, p,\ \lambda_{\min},\ \lambda_{\max}\right)
$$

where:

- $p$ is the user-controlled pressure term,
- $\nabla_i A$ is the area gradient with respect to vertex $i$.

For polygon vertex $i$, the discrete area gradient used in the code is:

$$
\nabla_i A =
\begin{bmatrix}
\frac{1}{2}(y_{i+1} - y_{i-1}) \\
\frac{1}{2}(x_{i-1} - x_{i+1})
\end{bmatrix}
$$

Each movable boundary particle is displaced by:

$$
\mathbf{x}_i \leftarrow \mathbf{x}_i + \lambda \nabla_i A
$$

This behaves like an inexpensive pressure or volume-preservation term. It is not a full fluid model or continuum elasticity law, but it significantly improves the visual plausibility of the body.

## 7. Boundary Collisions Against the Canvas

The simulation domain is the canvas rectangle. For each particle:

- if $x < r$, project it back to $x = r$,
- if $x > W - r$, project it back to $x = W - r$,
- if $y < r$, project it back to $y = r$,
- if $y > H - r$, project it back to $y = H - r$.

To simulate bounce, the code also updates the previous position so that the reconstructed velocity reverses partially:

$$
x_{\text{old}} \leftarrow x_{\text{new}} + b \, v_x
$$

$$
y_{\text{old}} \leftarrow y_{\text{new}} + b \, v_y
$$

where $b$ is the user-controlled bounce factor.

This is a common Verlet trick: by modifying the previous position, you indirectly control the post-collision velocity.

## 8. Inter-Body Collision Detection

The app supports multiple soft bodies colliding with one another. Collision handling is based on the triangulated boundary of each body.

### 8.1 Polygon triangulation

Each boundary polygon is triangulated using an ear-clipping method. A polygon with vertices:

$$
\{\mathbf{p}_0, \mathbf{p}_1, \dots, \mathbf{p}_{n-1}\}
$$

is decomposed into non-overlapping triangles:

$$
T_k = (\mathbf{a}_k, \mathbf{b}_k, \mathbf{c}_k)
$$

This allows the code to test whether a point from one body has penetrated the interior of another body.

### 8.2 Point-in-triangle test by area sum

For a point $\mathbf{p}$ and triangle $(\mathbf{a}, \mathbf{b}, \mathbf{c})$, the code uses the area-sum identity.

Let:

$$
A_{\triangle} = A(\mathbf{a}, \mathbf{b}, \mathbf{c})
$$

$$
A_1 = A(\mathbf{p}, \mathbf{a}, \mathbf{b}), \quad
A_2 = A(\mathbf{p}, \mathbf{b}, \mathbf{c}), \quad
A_3 = A(\mathbf{p}, \mathbf{c}, \mathbf{a})
$$

Then the point is inside the triangle when:

$$
A_1 + A_2 + A_3 \approx A_{\triangle}
$$

In the implementation, the code uses doubled signed triangle area for efficiency:

$$
2A = (\mathbf{b}-\mathbf{a}) \times (\mathbf{c}-\mathbf{a})
$$

and compares the absolute area sum against the triangle area with a small tolerance.

### 8.3 Penetration resolution

If a particle lies inside one of the target body's triangles:

1. find the closest point on each triangle edge,
2. choose the nearest edge,
3. construct a correction vector that pushes the particle out of the triangle,
4. distribute part of that correction back to the triangle vertices.

In effect:

$$
\mathbf{x}_{\text{source}} \leftarrow \mathbf{x}_{\text{source}} + \alpha \, \Delta \mathbf{x}
$$

$$
\mathbf{x}_{\text{triangle vertex}} \leftarrow \mathbf{x}_{\text{triangle vertex}} - \beta \, \Delta \mathbf{x}
$$

with weights $\alpha$ and $\beta$ chosen heuristically.

This is not an impulse-based rigid-body collision law. It is a geometric position correction method, consistent with the rest of the position-based solver.

## 9. Broad Phase Acceleration With a Cartesian Grid

Testing every particle against every triangle would be too expensive as the number of bodies grows. To reduce unnecessary work, each body caches its collision triangles into a uniform Cartesian grid.

### Grid idea

For a cell size $h$, a triangle with bounding box:

$$
[x_{\min}, x_{\max}] \times [y_{\min}, y_{\max}]
$$

is inserted into every grid cell overlapped by that box.

When testing a particle of radius $r$, the solver only queries cells overlapping:

$$
[x-r, x+r] \times [y-r, y+r]
$$

This changes the broad-phase cost from "scan all triangles" to "scan only nearby triangle candidates", which is critical when many bodies are on screen.

## 10. Substepping and Iterative Stability

Real-time interactive simulations are always balancing speed against numerical stability. This app uses several techniques together:

### Fixed time step

The render loop may run at a variable frame rate, but physics is accumulated and stepped at a fixed rate:

$$
\Delta t = \frac{1}{60}\ \text{s}
$$

This improves consistency and reduces frame-rate-dependent behavior.

### Substeps

Each frame step is split into smaller steps:

$$
\Delta t_{\text{sub}} = \frac{\Delta t}{N_{\text{substeps}}}
$$

Smaller substeps reduce tunneling and make the constraint solver more stable.

### Multiple solver iterations

Distance and area constraints are projected multiple times per substep. More iterations make the body stiffer and reduce drift.

### Multiple collision passes

Inter-body collisions are resolved in several passes after the internal constraints. This is important when many bodies stack or compress together. The app also increases effective collision passes when the body count becomes large.

### Velocity limiting

Before integrating, the inferred velocity is clamped. This prevents extreme particle motion from destabilizing the solver.

### Damping

Damping removes energy gradually and suppresses persistent oscillations.

## 11. Building a Body From a Drawn or Preset Shape

The conversion pipeline is:

1. start from a polygon,
2. resample the boundary to roughly uniform spacing,
3. enforce counter-clockwise winding,
4. generate interior particles on a staggered lattice,
5. create structural constraints among nearby particles,
6. triangulate the boundary for collision queries.

This creates a deformable particle graph from either:

- a preset polygon,
- or a freehand drawn loop.

## 12. User Interaction

When the user grabs a body:

- the nearest particle in the selected body is pinned,
- its pin position is updated from pointer motion,
- the pin velocity is inferred from pointer movement,
- on release, the particle is unpinned and inherits momentum.

This makes dragging feel responsive while still respecting the solver.

## 13. Simulation Loop Summary

For each fixed simulation step:

1. split the step into substeps,
2. integrate all bodies with damped Verlet,
3. iterate internal constraints and area preservation,
4. collide particles against world bounds,
5. refresh collision caches,
6. resolve inter-body penetrations using triangle tests,
7. render the result through the WebGL canvas pipeline.

In pseudocode:

```text
for each fixed step:
    for each substep:
        integrate particles
        repeat iterations:
            solve distance constraints
            solve area constraint
            solve world-boundary collisions
        repeat collision passes:
            refresh triangle caches
            solve body-vs-body penetrations
            solve world-boundary collisions again
```

## 14. Interpreting the Controls

- `Gravity X / Y`: uniform acceleration field.
- `Wind X / Y`: additional uniform acceleration.
- `Constraint Stiffness`: how strongly distance constraints enforce rest lengths.
- `Pressure`: how strongly the area target is restored.
- `Damping`: how much of the inferred velocity survives each step.
- `Collision Bounce`: how much velocity is reflected on wall contact.
- `Solver Iterations`: number of internal constraint projection passes.
- `Substeps`: number of smaller time slices per fixed frame.
- `Collision Passes`: number of repeated inter-body penetration solves.

## 15. Limitations

This is an educational and interactive solver, not a full production continuum mechanics engine.

Important limitations:

- no true constitutive material model,
- no angular momentum preservation,
- no exact contact manifold generation,
- no continuous collision detection,
- no finite-element stress-strain computation,
- heuristic collision correction weights,
- stiffness depends somewhat on iteration count and time step.

These tradeoffs are intentional to keep the app simple, browser-native, and interactive.

---

## License

Copyright (c) 2026 Ilya Tsivilskiy

This repository is provided under an **all rights reserved** notice. No permission is granted to use, copy, modify, distribute, or exploit this software, including for commercial purposes, without prior written permission from the author. No patent license is granted.

See [LICENSE](./LICENSE) for the full terms.