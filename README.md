# Vroom Vroom 🏎️

An open-world arcade driving game for the browser, built with [three.js](https://threejs.org).
It has no build step and no runtime downloads. It is plain ES modules and static files, so it can be hosted on
GitHub Pages or itch.io as-is.

## Features

**Arcade driving**
- Simple, forgiving handling, with handbrake drifts, nitro, big jumps and air-steer spins
- Each surface drives differently: asphalt, concrete, dirt, grass, sand, snow, rock and shallow water
- Weather changes grip. Rain and snow make roads slippery, and storms bring wind gusts, lightning and thunder
- Arcade collisions with buildings, trees, rocks, lamp posts and traffic. Cones, barrels, crates and hay bales can be knocked flying

**Car customisation**
- 10 vehicles: hatchback, sedan, muscle car, rally car, sports car, SUV, pickup, van, monster truck and hypercar
- Performance upgrades change the numbers, not the visuals: engine, gearbox, nitro, brakes, suspension and weight reduction
- 5 tire compounds (street, sport, slicks, off-road, winter), each with its own tarmac, off-road and snow grip
- Free paint colours plus gloss, metallic, matte and chrome finishes

**Open world** (2.4 km × 2.4 km)
- A downtown city grid, a ring highway and connector roads
- Snowy mountains with a winding pass, desert dunes with a stunt park and a rally loop, a forest trail, and countryside with a lake and an airfield
- A day/night cycle (lit windows, street lamps, headlights) and a dynamic weather cycle

**Activities**
- 7 checkpoint races with gold, silver and bronze times and saved personal bests
- 7 challenges: Big Air, Mega Ramp distance, two drift zones, Smash Fest, Speed Run and Spin Doctor
- Delivery jobs between 7 depots. Pay depends on time and cargo condition, and trucks and vans earn more
- Free-roam rewards for jumps, drifts, smashing props and speed traps
- 40 hidden golden wrenches to collect

**Life sim**
- Money and XP, with player levels that unlock cars
- 7 properties to buy. Each one gives daily income, a garage and a fast-travel point
- Career stats, autosave to `localStorage`, and a GPS waypoint you set from the world map

## Controls

| Key | Action |
|---|---|
| W A S D / arrows | Drive and steer (S brakes, then reverses) |
| Space | Handbrake / drift |
| Shift | Nitro |
| E | Start an event or enter a garage at a marker |
| G | Garage |
| M | World map (click to set a waypoint, fast travel) |
| C / B | Change camera / look back |
| R | Reset car to the road |
| Backspace | Quit the current event |
| Esc | Pause menu, settings, weather and time of day |

Gamepads work too: RT/LT to drive, the left stick to steer, A for handbrake, B for nitro, X to interact and Y to change camera.
On touch devices, on-screen buttons appear.

## Run locally

Any static file server will do. ES modules don't load from `file://`, so you need a server.

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Deploy

### GitHub Pages
`.github/workflows/pages.yml` deploys the site whenever `main` is pushed.
To turn it on, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
The workflow checks out LFS files, so any Kenney models you add are included.

### itch.io
Zip `index.html`, `style.css`, `src/`, `vendor/` and `assets/`. Upload the zip as an HTML game
and tick "This file will be played in the browser".

## Assets

Everything is procedural by default: the cars, buildings, terrain, textures and synthesized audio.
That keeps the repository tiny, and the game works right away.

To use the [Kenney Car Kit](https://kenney.nl/assets/car-kit) (CC0) models instead, see
[`assets/kenney/car-kit/README.md`](assets/kenney/car-kit/README.md). In short, drop the `.glb` files in that folder and set
`USE_KENNEY_CARS = true` in `src/config.js`. `.gitattributes` already routes `*.glb` and audio files through Git LFS.

three.js r170 is vendored in `vendor/three/` (MIT licence), so the game doesn't rely on a CDN.

## Project layout

```
index.html, style.css     page shell, HUD and menu styles
src/main.js               game loop, camera, rewards, wiring
src/world.js              heightmap terrain, biomes, roads, city, ramps, vegetation, props, colliders
src/car.js                arcade vehicle physics and procedural car models (optional Kenney GLBs)
src/vehicles.js           vehicle catalogue, upgrades, tires, paints, stat formulas
src/environment.js        sky, sun, day/night cycle, weather and precipitation
src/traffic.js            ambient traffic on the highway and city loops
src/activities.js         races, challenges, deliveries, properties, collectibles, speed traps
src/ui.js                 HUD, minimap, garage, world map, menus
src/audio.js              Web Audio synthesized engine, skids, wind, rain and UI sounds
src/input.js              keyboard, gamepad and touch input
src/state.js              save data, money, XP and levels
src/config.js             asset toggles
```

## Ideas for next steps
- Multiplayer (the stretch goal): a small WebSocket relay or WebRTC (for example PeerJS) that syncs car transforms for cruising together, then ghost races
- AI opponents in races (the traffic lane-follower is a good starting point)
- Leaderboards for race times and challenge scores
- More vehicle classes and visual tuning parts once real models are in
