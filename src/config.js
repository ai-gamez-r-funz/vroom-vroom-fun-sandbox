// Asset configuration.
//
// The game ships with procedural low-poly cars so it runs with zero downloads.
// To use the Kenney "Car Kit" models (CC0, https://kenney.nl/assets/car-kit):
//   1. Download the kit and copy the .glb files from "Models/GLB format/" into
//      assets/kenney/car-kit/ (e.g. assets/kenney/car-kit/sedan.glb).
//   2. Set USE_KENNEY_CARS to true below.
// Vehicles whose model file is missing silently fall back to the procedural model.
export const USE_KENNEY_CARS = false;

// If a Kenney model faces backwards in-game, add its file name here.
export const KENNEY_FLIP = new Set([]);
