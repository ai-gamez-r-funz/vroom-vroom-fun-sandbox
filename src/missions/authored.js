// Hand-authored "story" missions, written in the same JSON schema the Forge produces
// (see MISSION_SCHEMA in forge.js). Extra conveniences for authors:
//   - { "place": "Landmark Name" } anywhere a point is expected resolves to that landmark
//   - "spawn": "near" places a chase target on a road 120–250 m from the player
//   - "spawn": "beside" places a duel rival next to the player
// Tip: generate a mission in the Forge tab of the Job Board, tweak its JSON and paste it here.

export const AUTHORED = [
  {
    id: 'story-eggs', type: 'cargo', icon: '🥚', title: 'The Great Egg Run', giver: 'Old Man Hargrove', minLevel: 1,
    desc: 'Hargrove\'s hens laid a record batch. Take 400 eggs from the farm to the Big Wheel Diner — without making an omelette.',
    difficulty: 0.4, timeLimit: 240,
    cargo: { kind: 'fragile', name: 'Eggs', fragility: 3 },
    stages: [
      { type: 'goto', to: { place: 'Sunny Acres Barn' }, radius: 12, stop: true, stopTime: 2, text: 'Load the eggs at Sunny Acres Barn' },
      { type: 'goto', to: { place: 'Big Wheel Diner' }, radius: 10, stop: true, stopTime: 1.5, text: 'Deliver to the Big Wheel Diner' },
    ],
    reward: { money: 3500, xp: 600 },
    bonus: { classes: ['Truck', 'Van'], mult: 1.3 },
  },
  {
    id: 'story-icecream', type: 'chase', icon: '🍦', title: 'Mr. Whippy Went Wild', giver: 'Sgt. Rhodes — Police', minLevel: 1,
    desc: 'An ice cream van with no driver is rolling through town playing Greensleeves at 120 km/h. Stop it!',
    difficulty: 0.3, timeLimit: 150,
    cargo: { kind: 'none' },
    stages: [{
      type: 'chase', mode: 'catch', spawn: 'near', vehicle: 'van', paint: '#ffc0e0',
      rope: { tag: 13, max: 180, grace: 7 }, tagTime: 3.5, speed: 26, engageTime: 50, text: 'Catch the runaway ice cream van!',
    }],
    reward: { money: 3000, xp: 500 },
  },
  {
    id: 'story-mayor', type: 'tail', icon: '🎩', title: 'The Mayor\'s Secret', giver: 'Daily Gazette', minLevel: 2,
    desc: 'Every Friday the Mayor drives off alone. The Gazette wants to know where. Don\'t get spotted.',
    difficulty: 0.5, timeLimit: 0,
    cargo: { kind: 'none' },
    stages: [{
      type: 'chase', mode: 'tail', spawn: 'near', vehicle: 'sedan', paint: '#111111', dest: { place: 'Lake Glimmer Beach' },
      rope: { min: 26, max: 130, grace: 6 }, speed: 18, engageTime: 45, text: 'Tail the Mayor\'s limo',
    }],
    reward: { money: 5000, xp: 900 },
  },
  {
    id: 'story-blitz', type: 'timetrial', icon: '⏱', title: 'Downtown Delivery Blitz', giver: 'Rush Courier Co.', minLevel: 1,
    desc: 'Four urgent parcels, four corners of town. Gold time is 75 seconds.',
    difficulty: 0.5, timeLimit: 0, par: 75,
    cargo: { kind: 'none' },
    stages: [
      { type: 'goto', to: { place: 'Big Wheel Diner' }, radius: 14, text: 'Big Wheel Diner' },
      { type: 'goto', to: { place: 'City Stadium' }, radius: 14, text: 'City Stadium' },
      { type: 'goto', to: { place: 'Police HQ' }, radius: 14, text: 'Police HQ' },
      { type: 'goto', to: { place: 'Grand Central Station' }, radius: 14, text: 'Grand Central Station' },
    ],
    reward: { money: 2500, xp: 450 },
  },
  {
    id: 'story-rival', type: 'duel', icon: '🏁', title: 'Kat Kerbs Wants a Race', giver: 'Kat Kerbs', minLevel: 2,
    desc: 'The city\'s fastest courier says you can\'t beat her to the Airfield Tower. Prove her wrong.',
    difficulty: 0.6, timeLimit: 0,
    cargo: { kind: 'none' },
    stages: [{ type: 'duel', rival: { vehicle: 'sports', paint: '#ff4fa3', name: 'Kat Kerbs' }, spawn: 'beside', to: { place: 'Airfield Control Tower' }, speed: 36, text: 'Beat Kat to the Airfield Control Tower' }],
    reward: { money: 6000, xp: 1000 },
  },
  {
    id: 'story-summit', type: 'sightseeing', icon: '🏔️', title: 'Top of the World', giver: 'Glossy Travel Mag', minLevel: 1,
    desc: 'Drive to Frostbite Summit and take the cover photo for the winter issue.',
    difficulty: 0.2, timeLimit: 0,
    cargo: { kind: 'none' },
    stages: [{ type: 'goto', to: { place: 'Frostbite Summit' }, radius: 20, stop: true, stopTime: 3, text: 'Park at Frostbite Summit for the photo' }],
    reward: { money: 2000, xp: 400 },
  },
];
