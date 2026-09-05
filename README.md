# Orbital — Planets Sandbox 3D Test

An independent 3D browser experiment inspired by the gravity sandbox genre. The existing Planets-Sandbox-Remastered1 repository is unchanged.

Run `python3 -m http.server 4181` and open localhost:4181. No build or remote JavaScript dependencies are required. Three.js is vendored under its MIT license.

Features: a brighter 3D camera with orbit/pan/zoom, eight planets and eight major moons, body picking/follow, Newtonian 3D pairwise gravity with leapfrog integration and bounded adaptive steps, adjustable gravity and 3-axis velocity, editable water/ice/land/ocean/atmosphere, visible magnetic fields, rings, object spawning, stellar flares, supernova collapse, trails with adjustable length, axes, moon visibility, clear/reset, and local save/load.

Collisions merge mass and momentum, exchange surface water and ice, strip atmosphere according to impact speed, heat the survivor, update its surface, and display an expanding impact wave. These are gameplay-oriented physical approximations rather than a research-grade hydrodynamics model.

This is a basic experimental simulator. Body radii and the Moon's orbit are enlarged for interaction. Collisions use visual radii, thermal behavior and atmospheres are illustrative, and black holes use Newtonian gravity with a decorative disk rather than general relativity. It does not implement Universe Sandbox's climate, Roche fragmentation, stellar evolution, or full material simulation. Planet spin is accelerated for visibility. All bodies affect gravity; the primary star provides scene lighting.

Research references: https://universesandbox.com/ — gravity, climate and collisions; https://universesandbox.com/support/controls/ — camera interaction; https://threejs.org/manual/en/installation.html — renderer and controls. Earth texture: https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg (official Three.js example asset). Other textures are procedural.
