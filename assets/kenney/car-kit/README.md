# Kenney Car Kit (optional)

Drop the `.glb` files from Kenney's **Car Kit** (CC0 — https://kenney.nl/assets/car-kit)
into this folder, then set `USE_KENNEY_CARS = true` in `src/config.js`.

File names the game looks for (one per vehicle, see `kenney:` in `src/vehicles.js`):

| Vehicle          | File                    |
|------------------|-------------------------|
| Pip Hatchback    | `hatchback-sports.glb`  |
| Civic Cruiser    | `sedan.glb`             |
| Thunder V8       | `sedan-sports.glb`      |
| Gravel Fox       | `race.glb`              |
| Vento GT         | `sedan-sports.glb`      |
| Ranger SUV       | `suv.glb`               |
| Haul-Rite Pickup | `truck.glb`             |
| Parcel Van       | `van.glb`               |
| Big Stomp        | `suv-luxury.glb`        |
| Aero X Hyper     | `race-future.glb`       |

Missing files fall back to the built-in procedural models, so you can add them one at a time.
`.glb` files are tracked with Git LFS via the repository's `.gitattributes`
(run `git lfs install` once before committing them).

If a model appears backwards, add its file name to `KENNEY_FLIP` in `src/config.js`.
The game auto-scales each model to the vehicle's length; meshes whose names contain
"wheel" are spun as wheels, and materials named like "body"/"paint" take the chosen paint colour.
