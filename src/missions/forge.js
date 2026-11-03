// The Mission Forge: rule-driven procedural mission generator.
//
// Every mission is a plain JSON "spec" (see MISSION_SCHEMA below) made of stages.
// Templates turn a seed + context into a spec; the Director decides which templates
// to offer the player as they drive, based on the rules in DIRECTOR_RULES.
import { mulberry32, clamp } from '../util.js';
import { CITY_HALF } from '../world.js';
import { regionName } from './places.js';

export const MISSION_SCHEMA = `{
  "type": "taxi",                      // template id
  "title": "...", "giver": "...", "icon": "🚕", "desc": "...",
  "difficulty": 0.4,                   // 0..1
  "start": { "x": 0, "z": 0, "yaw": 0 }, // where Retry puts the player
  "timeLimit": 120,                    // seconds, 0 = untimed
  "cargo": { "kind": "passenger|patient|fragile|cargo|none", "name": "...", "personality": "hurry|nervous|thrill|tourist", "fragility": 1 },
  "reward": { "money": 1200, "xp": 200 },
  "par": 80,                           // optional: medal time (gold = par, silver = par*1.15, bronze = par*1.35)
  "bonus": { "classes": ["Van"], "mult": 1.5 },
  "stages": [
    { "type": "goto", "to": {"name":"...","x":0,"z":0}, "radius": 8, "stop": true, "stopTime": 1.5, "text": "..." },
    { "type": "collect", "points": [{"x":0,"z":0}], "text": "..." },
    { "type": "chase", "mode": "catch|tail", "spawn": {"x":0,"z":0,"yaw":0}, "vehicle": "muscle", "paint": "#fff",
      "dest": {"x":0,"z":0}, "rope": {"tag": 12, "min": 25, "max": 150, "grace": 6}, "tagTime": 4, "speed": 30, "text": "..." },
    { "type": "evade", "pursuers": 2, "vehicle": "sedan", "rope": {"tag": 9, "max": 170}, "holdTime": 5, "bustTime": 3, "text": "..." },
    { "type": "duel", "rival": {"vehicle":"sports","paint":"#f0f"}, "spawn": {...}, "to": {...}, "text": "..." },
    { "type": "stunt", "kind": "air|jumpdist|drift|speed|smash", "target": 2, "time": 60, "text": "..." }
  ]
}`;

// ---------------------------------------------------------------------------------------------
// Director rules: each rule looks at the context and boosts (or suppresses) mission types.
// ctx: { inCity, region, night, weather, speed, cls, level, recent: [types] }
export const DIRECTOR_RULES = {
  offerEvery: [22, 45], // seconds of free driving between job offers
  offerLifetime: 18, // seconds to accept before the offer expires
  boardSize: 5,
  rules: [
    { name: 'City streets', when: (c) => c.inCity, boost: { taxi: 2.2, emergency: 1.5, timetrial: 1.3, tail: 1.3 } },
    { name: 'Out in the wilds', when: (c) => !c.inCity, boost: { fetch: 1.8, scavenger: 1.8, sightseeing: 1.6, taxi: 0.3 } },
    { name: 'Night shift', when: (c) => c.night, boost: { chase: 2, evade: 1.6, tail: 1.5, sightseeing: 0.4 } },
    { name: 'Bad weather', when: (c) => ['rain', 'storm', 'snow', 'fog'].includes(c.weather), boost: { fetch: 1.8, emergency: 1.5, stunt: 0.5 } },
    { name: 'Driving a work vehicle', when: (c) => ['Van', 'Truck'].includes(c.cls), boost: { cargo: 3, fetch: 1.3, chase: 0.6 } },
    { name: 'Driving something fast', when: (c) => ['Sports', 'Hypercar', 'Muscle'].includes(c.cls), boost: { timetrial: 2, chase: 1.6, duel: 2, evade: 1.4 } },
    { name: 'Off-road ready', when: (c) => ['Rally', 'SUV', 'Monster'].includes(c.cls), boost: { fetch: 2, scavenger: 1.8, stunt: 1.5 } },
    { name: 'Everyday car', when: (c) => ['Compact', 'Sedan'].includes(c.cls), boost: { taxi: 1.8, cargo: 1.2 } },
    { name: 'Near the stunt park', when: (c) => c.region === 'Sunscorch Desert' || c.region === 'Airfield', boost: { stunt: 3 } },
    { name: 'Flying along', when: (c) => c.speed > 28, boost: { chase: 1.5, duel: 1.5, timetrial: 1.3 } },
    { name: 'Keep it fresh', when: () => true, boost: (c) => Object.fromEntries(c.recent.map((t) => [t, 0.25])) },
  ],
};

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const PAINTS = ['#e8463a', '#3a7be8', '#f2b705', '#22c46e', '#ffffff', '#111111', '#8a2be2', '#ff7f11'];

// ---------------------------------------------------------------------------------------------
// Templates
export const TEMPLATES = {
  emergency: {
    name: 'Emergency Call', icon: '🚑', minLevel: 1, weight: 1,
    blurb: 'Point-to-point time trial: reach the scene, then rush to hospital.',
    build(ctx) {
      const { rnd, places, origin, d } = ctx;
      const fire = rnd() < 0.35;
      const scene = places.pick(rnd, origin, 250, 700 + d * 500, ['city', 'road', 'landmark']);
      if (fire) {
        const len = ctx.route(origin, scene);
        return {
          title: pick(rnd, ['Kitchen Fire', 'Barn Blaze', 'Cat Up A Burning Tree', 'Smoking Food Truck']),
          giver: 'Dispatch — Fire', icon: '🚒',
          desc: `Fire reported at ${scene.name} (${scene.region}). Get there fast and hose it down!`,
          timeLimit: Math.round(len / (17 + d * 9) + 12),
          cargo: { kind: 'none' },
          stages: [
            { type: 'goto', to: scene, radius: 14, text: `Race to the fire at ${scene.name}` },
            { type: 'goto', to: scene, radius: 16, stop: true, stopTime: 4, text: 'Park up and hose it down!' },
          ],
          reward: ctx.pay(len, 1.3),
          bonus: { classes: ['Truck', 'Van'], mult: 1.3 },
        };
      }
      const hospitals = places.byTag('hospital');
      hospitals.sort((a, b) => Math.hypot(a.x - scene.x, a.z - scene.z) - Math.hypot(b.x - scene.x, b.z - scene.z));
      const hosp = hospitals[0];
      const len = ctx.route(origin, scene) + ctx.route(scene, hosp);
      return {
        title: pick(rnd, ['Ambulance Run', 'Code Red', 'Broken Leg Express', 'Bee Sting Emergency']),
        giver: 'Dispatch — Medical', icon: '🚑',
        desc: `Patient at ${scene.name} (${scene.region}). Pick them up and get to ${hosp.name}. Smooth driving keeps them stable!`,
        timeLimit: Math.round(len / (16 + d * 9) + 20),
        cargo: { kind: 'patient', name: 'Patient', fragility: 1.2 },
        stages: [
          { type: 'goto', to: scene, radius: 10, stop: true, stopTime: 1.5, text: `Reach the patient at ${scene.name}` },
          { type: 'goto', to: hosp, radius: 12, stop: true, stopTime: 1, text: `Rush to ${hosp.name}` },
        ],
        reward: ctx.pay(len, 1.4),
        bonus: { classes: ['Van', 'SUV'], mult: 1.25 },
      };
    },
  },

  timetrial: {
    name: 'Point-to-Point', icon: '⏱', minLevel: 1, weight: 1,
    blurb: 'Hit each checkpoint in order. Medal times decide the pay.',
    build(ctx) {
      const { rnd, places, origin, d } = ctx;
      const n = 2 + Math.floor(rnd() * (2 + d * 2));
      const pts = [];
      let from = origin, len = 0;
      for (let i = 0; i < n; i++) {
        const p = places.pick(rnd, from, 200, 450 + d * 250, ['city', 'road', 'landmark']);
        len += ctx.route(from, p);
        pts.push(p);
        from = p;
      }
      const par = Math.round(len / (22 + d * 10));
      const theme = pick(rnd, [
        ['Courier Sprint', 'Rush Courier Co.', 'Urgent documents! Hit every drop point.'],
        ['Organ Transport', 'St. Piston General', 'A donor heart is on ice. Every second counts.'],
        ['Pizza Rush', 'Big Wheel Diner', '30 minutes or it is free. We do not do free.'],
        ['Late for the Wedding', 'Nervous Groom', 'The ceremony started already. Go go go!'],
      ]);
      return {
        title: theme[0], giver: theme[1], icon: '⏱',
        desc: `${theme[2]} ${n} checkpoints, ${(len / 1000).toFixed(1)} km. Gold: ${par}s.`,
        timeLimit: Math.round(par * 1.35),
        par,
        cargo: { kind: 'none' },
        stages: pts.map((p, i) => ({ type: 'goto', to: p, radius: 14, text: `Checkpoint ${i + 1}/${n}: ${p.name}` })),
        reward: ctx.pay(len, 1.2),
      };
    },
  },

  fetch: {
    name: 'Fetch Quest', icon: '🧺', minLevel: 1, weight: 1,
    blurb: 'Go and get something, then bring it back (or help a stranded driver).',
    build(ctx) {
      const { rnd, places, origin, d } = ctx;
      const stranded = ctx.badWeather ? rnd() < 0.6 : rnd() < 0.25;
      if (stranded) {
        const spot = places.roadsideSpot(rnd, (p) => Math.hypot(p.x - origin.x, p.z - origin.z) > 300 && Math.hypot(p.x - origin.x, p.z - origin.z) < 900);
        const len = ctx.route(origin, spot);
        return {
          title: 'Stranded Motorist', giver: 'Roadside Assist', icon: '⛽',
          desc: `A driver ran out of fuel on ${spot.name}. Bring them a jerry can before they freeze!`,
          timeLimit: Math.round(len / (14 + d * 8) + 30),
          cargo: { kind: 'cargo', name: 'Fuel can', fragility: 0.5 },
          stages: [{ type: 'goto', to: spot, radius: 10, stop: true, stopTime: 3, text: `Find the stranded driver: ${spot.name}` }],
          reward: ctx.pay(len, 1.1),
        };
      }
      const giver = { name: pick(rnd, ['Mrs. Hubcap', 'Old Man Hargrove', 'Ranger Lou', 'Professor Sprocket', 'Little Timmy']), x: origin.x, z: origin.z };
      const off = ctx.offroadCar || rnd() < 0.4;
      const where = off ? places.offroadSpot(rnd) : places.pick(rnd, origin, 250, 800, ['city', 'road', 'landmark']);
      if (Math.hypot(where.x - origin.x, where.z - origin.z) > 1100) Object.assign(where, places.pick(rnd, origin, 250, 800, ['road', 'landmark']));
      const item = pick(rnd, ['their lost dog, Biscuit', 'a picnic basket', 'a spare tire', 'a runaway camera drone', 'grandma\'s casserole dish', 'a toolbox', 'a prize-winning pumpkin']);
      const home = places.pick(rnd, origin, 0, 200, ['city', 'road', 'landmark']);
      giver.x = home.x; giver.z = home.z; giver.name = `${giver.name} (${home.name})`;
      const len = ctx.route(origin, where) * 2;
      return {
        title: `Fetch ${item.replace(/^(their|a|an) /, '').replace(/^\w/, (c) => c.toUpperCase())}`,
        giver: giver.name.split(' (')[0], icon: '🧺',
        desc: `Fetch ${item} from ${where.name} (${where.region}) and bring it back to ${home.name}.${off ? ' It\'s off-road!' : ''}`,
        timeLimit: Math.round(len / (12 + d * 7) + 40),
        cargo: { kind: 'cargo', name: item, fragility: 0.6 },
        stages: [
          { type: 'goto', to: where, radius: 12, stop: true, stopTime: 2, text: `Collect ${item} at ${where.name}` },
          { type: 'goto', to: { ...home, name: home.name }, radius: 10, stop: true, stopTime: 1, text: `Bring it back to ${home.name}` },
        ],
        reward: ctx.pay(len, 1.0 + (off ? 0.3 : 0)),
      };
    },
  },

  taxi: {
    name: 'Taxi Fare', icon: '🚕', minLevel: 1, weight: 1,
    blurb: 'Pick up a passenger and keep them happy. Each passenger has a personality.',
    build(ctx) {
      const { rnd, places, origin, d } = ctx;
      const pickup = places.pick(rnd, origin, 50, 260, ['city', 'landmark', 'road']);
      const drop = places.pick(rnd, pickup, 350, 900 + d * 600, ['city', 'road', 'landmark']);
      const personality = pick(rnd, ['hurry', 'nervous', 'thrill', 'tourist']);
      const names = ['Dot', 'Gus', 'Priya', 'Barnaby', 'Mei', 'Otto', 'Rosa', 'Sven', 'Tilly'];
      const name = pick(rnd, names);
      const flavour = {
        hurry: `${name} is late for a meeting — be quick!`,
        nervous: `${name} is a nervous passenger. No crashes, no big air, no crazy speeds.`,
        thrill: `${name} is an adrenaline junkie. Jumps, drifts and speed earn big tips!`,
        tourist: `${name} is visiting. Swing past a landmark on the way for a tip.`,
      }[personality];
      const stages = [{ type: 'goto', to: pickup, radius: 8, stop: true, stopTime: 1.2, text: `Pick up ${name} at ${pickup.name}` }];
      let len = ctx.route(origin, pickup) + ctx.route(pickup, drop);
      if (personality === 'tourist') {
        const lm = places.pick(rnd, pickup, 150, 900, ['landmark']);
        stages.push({ type: 'goto', to: lm, radius: 25, text: `Show ${name} the ${lm.name}`, optional: true });
        len += ctx.route(lm, drop);
      }
      stages.push({ type: 'goto', to: drop, radius: 9, stop: true, stopTime: 1, text: `Drop ${name} at ${drop.name}` });
      return {
        title: `Fare: ${name}`, giver: 'Yellow Wheel Cabs', icon: '🚕',
        desc: `${flavour} From ${pickup.name} to ${drop.name} (${drop.region}).`,
        timeLimit: Math.round(len / ((personality === 'hurry' ? 17 : 11) + d * 7) + 25),
        cargo: { kind: 'passenger', name, personality },
        stages,
        reward: ctx.pay(len, 1.1),
        bonus: { classes: ['Sedan', 'Compact'], mult: 1.2 },
      };
    },
  },

  cargo: {
    name: 'Delivery', icon: '📦', minLevel: 1, weight: 1,
    blurb: 'Carry goods from A to B. Fragile cargo hates crashes and hard landings.',
    build(ctx) {
      const { rnd, places, origin, d } = ctx;
      const type = pick(rnd, [
        { name: 'Wedding cake', fragility: 2.2, pace: 12, tag: 'fragile' },
        { name: 'Crate of eggs', fragility: 2.5, pace: 12, tag: 'fragile' },
        { name: 'Ice cream', fragility: 0.8, pace: 18, tag: 'perishable' },
        { name: 'Grand piano', fragility: 1.2, pace: 11, tag: 'heavy' },
        { name: 'Fireworks', fragility: 3, pace: 12, tag: 'explosive' },
        { name: 'Mail sacks', fragility: 0.4, pace: 15, tag: 'mail' },
      ]);
      const from = places.pick(rnd, origin, 60, 400, ['landmark', 'city', 'road']);
      const to = places.pick(rnd, from, 450, 1000 + d * 600, ['landmark', 'city', 'road', 'offroad']);
      const len = ctx.route(origin, from) + ctx.route(from, to);
      return {
        title: `${type.name} Delivery`, giver: pick(rnd, ['Haul-Rite Logistics', 'Big Wheel Diner', 'Sunny Acres Co-op', 'Parcel Pals']), icon: '📦',
        desc: `Load ${type.name.toLowerCase()} at ${from.name} and deliver to ${to.name} (${to.region}).${type.tag === 'fragile' || type.tag === 'explosive' ? ' Handle with care!' : ''}${type.tag === 'perishable' ? ' It melts — hurry!' : ''}`,
        timeLimit: Math.round(len / (type.pace + d * 6) + 30),
        cargo: { kind: 'fragile', name: type.name, fragility: type.fragility },
        stages: [
          { type: 'goto', to: from, radius: 10, stop: true, stopTime: 2, text: `Load up at ${from.name}` },
          { type: 'goto', to, radius: 12, stop: true, stopTime: 1.5, text: `Deliver to ${to.name}` },
        ],
        reward: ctx.pay(len, 1.15 + type.fragility * 0.1),
        bonus: { classes: ['Van', 'Truck'], mult: type.tag === 'heavy' ? 2 : 1.5 },
      };
    },
  },

  chase: {
    name: 'Pursuit', icon: '🚨', minLevel: 1, weight: 0.9,
    blurb: 'Catch a fleeing suspect. Stay on the rope: too far for too long and they escape.',
    build(ctx) {
      const { rnd, origin, d, graph } = ctx;
      const node = ctx.nodeAround(origin, 120, 260);
      const who = pick(rnd, [
        ['Runaway Ice Cream Van', 'van', '#ffc0e0', 'The brakes failed and it\'s playing the jingle on loop!'],
        ['Bank Robbers', 'sedan', '#222222', 'Two goons in a getaway car. Box them in!'],
        ['Street Racer', 'muscle', '#f2b705', 'Illegal racer tearing through town.'],
        ['Stolen Supercar', 'sports', '#e8463a', 'Someone nicked a Vento GT from the showroom.'],
        ['Speeding Hippies', 'van', '#22c46e', 'Their peace van is doing 140 in a school zone.'],
      ].filter((w) => d > 0.45 || w[1] !== 'sports'));
      const tagTime = 3 + d * 3;
      return {
        title: who[0], giver: 'Sgt. Rhodes — Police', icon: '🚨',
        desc: `${who[3]} Get close and stay on them (or ram them) to make the bust. Fall too far behind and they get away.`,
        timeLimit: 150,
        cargo: { kind: 'none' },
        stages: [{
          type: 'chase', mode: 'catch', spawn: { x: node.x, z: node.z, yaw: rnd() * Math.PI * 2 }, vehicle: who[1], paint: who[2],
          rope: { tag: 13, max: 190 - d * 50, grace: 7 - d * 2 }, tagTime, speed: 24 + d * 12, engageTime: 50,
          text: `Catch the ${who[0].toLowerCase()}!`,
        }],
        reward: ctx.pay(1200 + d * 800, 1.3),
        bonus: { classes: ['Sports', 'Hypercar', 'Muscle', 'Monster'], mult: 1.2 },
      };
    },
  },

  tail: {
    name: 'Tail', icon: '🕵️', minLevel: 2, weight: 0.8,
    blurb: 'Follow a target without being spotted: keep inside the rope, not too close, not too far.',
    build(ctx) {
      const { rnd, places, origin, d } = ctx;
      const node = ctx.nodeAround(origin, 70, 160);
      const dest = places.pick(rnd, node, 600, 1300, ['landmark', 'city', 'road']);
      const who = pick(rnd, [
        ['the Mayor', 'sedan', '#111111', 'The Mayor slipped his security detail. Where is he going?'],
        ['a cheating husband', 'hatch', '#3a7be8', 'Mrs. Gasket hired us. Find out where he goes.'],
        ['a suspected cake thief', 'van', '#ffffff', 'Follow the van back to its hideout.'],
        ['a rival tuner', 'sports', '#22c46e', 'Find the secret garage where they build those engines.'],
      ]);
      return {
        title: `Tail ${who[0]}`, giver: 'P.I. Pemberton', icon: '🕵️',
        desc: `${who[3]} Stay between the rope limits: get too close and they spot you, too far and you lose them.`,
        timeLimit: 0,
        cargo: { kind: 'none' },
        stages: [{
          type: 'chase', mode: 'tail', spawn: { x: node.x, z: node.z, yaw: 0 }, vehicle: who[1], paint: who[2], dest,
          rope: { min: 22 + d * 8, max: 150 - d * 40, grace: 6 }, speed: 15 + d * 6, engageTime: 40,
          text: `Tail ${who[0]} to their destination`,
        }],
        reward: ctx.pay(ctx.route(node, dest), 1.4),
      };
    },
  },

  evade: {
    name: 'Getaway', icon: '🚔', minLevel: 2, weight: 0.7,
    blurb: 'Lose your pursuers: open up the rope until it snaps, then hold the gap.',
    build(ctx) {
      const { rnd, d } = ctx;
      const paparazzi = rnd() < 0.35;
      const n = 1 + Math.floor(rnd() * (1.5 + d * 2));
      return {
        title: paparazzi ? 'Paparazzi Panic' : 'Hot Pursuit',
        giver: paparazzi ? 'Celebrity Client' : 'Street Racing Crew', icon: paparazzi ? '📸' : '🚔',
        desc: paparazzi
          ? `A pop star is hiding in your back seat and ${n} photographers are on your tail. Lose them!`
          : `The cops spotted your crew's street race. ${n} cruiser${n > 1 ? 's are' : ' is'} after you — shake them off!`,
        timeLimit: 120,
        cargo: { kind: paparazzi ? 'passenger' : 'none', name: 'Pop star', personality: 'thrill' },
        stages: [{
          type: 'evade', pursuers: n, vehicle: paparazzi ? 'van' : 'sedan', police: !paparazzi, paint: paparazzi ? '#cccccc' : '#f5f5f5',
          rope: { tag: 9, max: 160 + d * 60 }, holdTime: 5 + d * 3, bustTime: 3.5 - d, speed: 30 + d * 14,
          text: 'Get away! Break the rope and stay out of reach.',
        }],
        reward: ctx.pay(1500 + n * 600, 1.2),
      };
    },
  },

  duel: {
    name: 'Rival Duel', icon: '🏁', minLevel: 2, weight: 0.7,
    blurb: 'A rival challenges you to a race across town. First one there wins.',
    build(ctx) {
      const { rnd, places, origin, d } = ctx;
      const to = places.pick(rnd, origin, 600, 1300, ['landmark', 'road', 'city']);
      const rival = pick(rnd, [['Vinnie "Nitro" Valvez', 'muscle', '#f2b705'], ['Kat Kerbs', 'sports', '#ff4fa3'], ['Duke Dustcloud', 'rally', '#ffffff'], ['Bubbles McGee', 'hatch', '#1fb5c9']]);
      const yaw = ctx.carYaw;
      const side = { x: origin.x + Math.cos(yaw) * 5, z: origin.z - Math.sin(yaw) * 5, yaw };
      return {
        title: `Duel vs ${rival[0]}`, giver: rival[0], icon: '🏁',
        desc: `${rival[0]} reckons you can't beat them to ${to.name} (${to.region}). Any route goes!`,
        timeLimit: 0,
        cargo: { kind: 'none' },
        stages: [{ type: 'duel', rival: { vehicle: rival[1], paint: rival[2], name: rival[0] }, spawn: side, to, speed: 28 + d * 16, text: `Beat ${rival[0]} to ${to.name}` }],
        reward: ctx.pay(ctx.route(origin, to) + 600, 1.5),
      };
    },
  },

  scavenger: {
    name: 'Scavenger Hunt', icon: '🔍', minLevel: 1, weight: 0.8,
    blurb: 'Collect every marked item in the area, in any order, before time runs out.',
    build(ctx) {
      const { rnd, places, origin, d } = ctx;
      const center = places.pick(rnd, origin, 150, 600, ['road', 'landmark', 'city']);
      const n = 4 + Math.floor(rnd() * (2 + d * 3));
      const pts = [];
      const inCity = Math.abs(center.x) < CITY_HALF && Math.abs(center.z) < CITY_HALF;
      for (let i = 0; i < n; i++) {
        let p;
        for (let k = 0; k < 40; k++) {
          p = inCity ? places.cityAddress(rnd) : places.offroadSpot(rnd);
          if (Math.hypot(p.x - center.x, p.z - center.z) < 280) break;
          if (!inCity) p = { x: center.x + (rnd() - 0.5) * 400, z: center.z + (rnd() - 0.5) * 400, name: 'spot' };
          if (!inCity && !places.blocked(p.x, p.z) && ctx.world.terrainHeight(p.x, p.z) > 1) break;
        }
        pts.push({ x: p.x, z: p.z, name: p.name });
      }
      const what = pick(rnd, ['lost luggage', 'escaped chickens', 'radio beacons', 'treasure map pieces', 'golf balls from a VERY bad golfer']);
      return {
        title: `Scavenger: ${what.split(' ').slice(-2).join(' ')}`, giver: 'Treasure Hunters Club', icon: '🔍',
        desc: `Round up ${n} ${what} around ${center.region}. Any order you like.`,
        timeLimit: Math.round(60 + n * 25 - d * 40),
        cargo: { kind: 'none' },
        stages: [
          { type: 'goto', to: center, radius: 40, text: `Head to ${center.region}` },
          { type: 'collect', points: pts, radius: 7, text: `Collect the ${what}` },
        ],
        reward: ctx.pay(n * 350 + 600, 1.2),
        bonus: { classes: ['Rally', 'SUV', 'Monster'], mult: 1.2 },
      };
    },
  },

  stunt: {
    name: 'Stunt Shoot', icon: '🎬', minLevel: 1, weight: 0.7,
    blurb: 'A film crew needs a stunt. Get to the set and nail the shot.',
    build(ctx) {
      const { rnd, places, origin, d, world } = ctx;
      const kinds = [
        { kind: 'air', target: +(1.4 + d * 1.6).toFixed(1), text: (t) => `Get ${t}s of airtime in one jump`, unit: 's' },
        { kind: 'jumpdist', target: Math.round(40 + d * 50), text: (t) => `Jump at least ${t} m`, unit: 'm' },
        { kind: 'drift', target: Math.round(600 + d * 1600), text: (t) => `Score a ${t}-point drift`, unit: 'pts' },
        { kind: 'speed', target: Math.round(150 + d * 90), text: (t) => `Hit ${t} km/h`, unit: 'km/h' },
        { kind: 'smash', target: Math.round(6 + d * 10), text: (t) => `Smash ${t} props`, unit: 'props' },
      ];
      const k = pick(rnd, kinds);
      let set;
      if (k.kind === 'air' || k.kind === 'jumpdist') {
        const ramps = world.ramps.filter((r) => r.h >= 4);
        const r = pick(rnd, ramps);
        set = { name: 'the ramp set', x: r.x - Math.sin(r.yaw) * (r.len / 2 + 60), z: r.z - Math.cos(r.yaw) * (r.len / 2 + 60), region: regionName(r.x, r.z) };
      } else if (k.kind === 'smash') set = { name: 'Stunt Park', x: 510, z: 290, region: 'Stunt Park' };
      else if (k.kind === 'speed') set = { ...places.byTag('landmark').find((l) => l.name.includes('Airfield')) };
      else set = places.pick(rnd, origin, 100, 700, ['road', 'city']);
      return {
        title: pick(rnd, ['Fast & Curious 9', 'Cop Show Pilot', 'Car Commercial', 'Music Video', 'Action Movie Reshoot']),
        giver: 'Director Spielbolt', icon: '🎬',
        desc: `Get to ${set.name} (${set.region}) and ${k.text(k.target).toLowerCase()} within 60 seconds once the cameras roll.`,
        timeLimit: 0,
        cargo: { kind: 'none' },
        stages: [
          { type: 'goto', to: set, radius: 20, text: `Get to ${set.name}` },
          { type: 'stunt', kind: k.kind, target: k.target, unit: k.unit, time: 60, text: k.text(k.target) },
        ],
        reward: ctx.pay(1400 + d * 1200, 1.3),
      };
    },
  },

  sightseeing: {
    name: 'Photo Op', icon: '📸', minLevel: 1, weight: 0.5,
    blurb: 'Untimed exploration: drive to a scenic spot and park for the photo.',
    build(ctx) {
      const { rnd, places, origin } = ctx;
      const spot = places.pick(rnd, origin, 300, 1600, ['landmark', 'offroad']);
      return {
        title: `Postcard: ${spot.name}`, giver: 'Glossy Travel Mag', icon: '📸',
        desc: `Snap a photo at ${spot.name} in ${spot.region}. No rush — enjoy the drive.`,
        timeLimit: 0,
        cargo: { kind: 'none' },
        stages: [{ type: 'goto', to: spot, radius: 18, stop: true, stopTime: 3, text: `Park at ${spot.name} for the photo` }],
        reward: ctx.pay(ctx.route(origin, spot), 0.8),
      };
    },
  },
};

// ---------------------------------------------------------------------------------------------
export class MissionForge {
  constructor(game) {
    this.game = game;
  }

  context(seed, opts = {}) {
    const g = this.game;
    const rnd = mulberry32(seed);
    const car = g.car;
    const level = g.state.level;
    const d = clamp(opts.difficulty ?? 0.15 + level * 0.08 + rnd() * 0.2, 0, 1);
    const origin = opts.origin || { x: car.pos.x, z: car.pos.z };
    return {
      rnd, d, level, origin, world: g.world, graph: g.graph, places: g.places,
      carYaw: car.yaw,
      offroadCar: ['Rally', 'SUV', 'Monster'].includes(car.def.cls),
      badWeather: ['rain', 'storm', 'snow', 'fog'].includes(g.env.weatherId),
      route: (a, b) => g.graph.routeLength(a.x, a.z, b.x, b.z),
      pay: (len, mult) => {
        const money = Math.round((250 + len * 0.9) * mult * (0.8 + d * 0.7) / 10) * 10;
        return { money, xp: Math.round(money / 5) };
      },
      nodeAround: (o, minD, maxD) => {
        const cands = g.graph.nodes.filter((n) => { if (!n.main) return false; const dd = Math.hypot(n.x - o.x, n.z - o.z); return dd >= minD && dd <= maxD; });
        return cands.length ? cands[Math.floor(rnd() * cands.length)] : g.graph.nearestNode(o.x + 150, o.z);
      },
    };
  }

  generate(type, opts = {}) {
    const seed = opts.seed ?? Math.floor(Math.random() * 1e9);
    const t = TEMPLATES[type];
    const ctx = this.context(seed, opts);
    const spec = t.build(ctx);
    const car = this.game.car;
    return {
      id: `${type}-${seed}`,
      seed, type,
      difficulty: +ctx.d.toFixed(2),
      start: opts.start || { x: +ctx.origin.x.toFixed(1), z: +ctx.origin.z.toFixed(1), yaw: +car.yaw.toFixed(3) },
      ...spec,
    };
  }

  // ---- Director: decides which mission types make sense right now
  directorContext(recent) {
    const g = this.game, car = g.car;
    return {
      inCity: Math.abs(car.pos.x) < CITY_HALF + 20 && Math.abs(car.pos.z) < CITY_HALF + 20,
      region: regionName(car.pos.x, car.pos.z),
      night: g.env.nightFactor > 0.5,
      weather: g.env.weatherId,
      speed: car.speed,
      cls: car.def.cls,
      level: g.state.level,
      recent,
    };
  }

  weights(recent = []) {
    const c = this.directorContext(recent);
    const w = {}, reasons = {};
    for (const [id, t] of Object.entries(TEMPLATES)) {
      w[id] = c.level >= t.minLevel ? t.weight : 0;
      reasons[id] = [];
    }
    for (const r of DIRECTOR_RULES.rules) {
      if (!r.when(c)) continue;
      const boost = typeof r.boost === 'function' ? r.boost(c) : r.boost;
      for (const [id, m] of Object.entries(boost)) {
        if (w[id] === undefined) continue;
        w[id] *= m;
        if (m > 1) reasons[id].push(r.name);
      }
    }
    return { w, reasons, ctx: c };
  }

  pickType(recent, exclude = []) {
    const { w, reasons } = this.weights(recent);
    const entries = Object.entries(w).filter(([id, v]) => v > 0 && !exclude.includes(id));
    let r = Math.random() * entries.reduce((s, [, v]) => s + v, 0);
    for (const [id, v] of entries) { r -= v; if (r <= 0) return { type: id, reasons: reasons[id] }; }
    return { type: entries[0][0], reasons: reasons[entries[0][0]] };
  }
}
