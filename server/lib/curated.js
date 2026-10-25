import { embedSources } from './providers.js';
import { imgProxy } from './images.js';
import { EXTRA_FILMS } from './curated-extra.js';
import { MORE_FILMS } from './curated-more.js';
import { DEEP_FILMS } from './curated-200.js';

/**
 * Hand-picked catalog for the titles people actually search for.
 *
 * TMDB's API needs a key, but its image CDN does not, so the metadata below is
 * frozen locally: the site still shows a modern "Newest releases" shelf with
 * real art and playable sources when TMDB_API_KEY is absent. Every id stays in
 * the tmdb:<id> namespace, so detail pages, watchlist entries, provider
 * preference and embeds behave exactly like a live TMDB result.
 */
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

const art = (path, size) => {
  if (!path) return null;
  return imgProxy(path.startsWith('http') ? path : `${IMAGE_BASE}/${size}${path}`);
};

const BASE_FILMS = [
  {
    tmdbId: 157336,
    title: 'Interstellar',
    year: 2014,
    release: '2014-11-05',
    runtime: 169 * 60,
    rating: 8.4,
    votes: 38_000,
    genres: ['Adventure', 'Drama', 'Science Fiction'],
    tagline: 'Mankind was born on Earth. It was never meant to die here.',
    overview:
      'With Earth\'s crops failing and the human race facing extinction, a former NASA pilot leads a small crew through a wormhole near Saturn in search of a new home. Every hour on the far side costs years back on Earth — and the daughter he left behind.',
    director: 'Christopher Nolan',
    cast: [
      { name: 'Matthew McConaughey', character: 'Cooper' },
      { name: 'Anne Hathaway', character: 'Brand' },
      { name: 'Jessica Chastain', character: 'Murph' },
      { name: 'Michael Caine', character: 'Professor Brand' },
      { name: 'Matt Damon', character: 'Mann' },
      { name: 'Casey Affleck', character: 'Tom' },
    ],
    production: ['Legendary Pictures', 'Syncopy', 'Warner Bros. Pictures'],
    posterPath: '/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg',
    backdropPath: '/xJHokMbljvjADYdit5fK5VQsXEG.jpg',
    featured: true,
  },
  {
    tmdbId: 693134,
    title: 'Dune: Part Two',
    year: 2024,
    release: '2024-02-27',
    runtime: 166 * 60,
    rating: 8.1,
    votes: 6_400,
    genres: ['Science Fiction', 'Adventure'],
    tagline: 'Long live the fighters.',
    overview:
      'Paul Atreides unites with Chani and the Fremen while seeking revenge against the conspirators who destroyed his family. Faced with a choice between the love of his life and the fate of the known universe, he must prevent a terrible future only he can foresee.',
    director: 'Denis Villeneuve',
    cast: [
      { name: 'Timothée Chalamet', character: 'Paul Atreides' },
      { name: 'Zendaya', character: 'Chani' },
      { name: 'Rebecca Ferguson', character: 'Lady Jessica' },
      { name: 'Austin Butler', character: 'Feyd-Rautha' },
      { name: 'Javier Bardem', character: 'Stilgar' },
      { name: 'Florence Pugh', character: 'Princess Irulan' },
    ],
    production: ['Legendary Pictures', 'Warner Bros. Pictures'],
    posterPath: '/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg',
    backdropPath: '/xOMo8BRK7PfcJv9JCnx7s5hj0PX.jpg',
    featured: true,
  },
  {
    tmdbId: 872585,
    title: 'Oppenheimer',
    year: 2023,
    release: '2023-07-19',
    runtime: 181 * 60,
    rating: 8.1,
    votes: 9_800,
    genres: ['Drama', 'History'],
    tagline: 'The world forever changes.',
    overview:
      'The story of J. Robert Oppenheimer, the theoretical physicist who led the Manhattan Project — and then spent the rest of his life living with what the Trinity test set loose.',
    director: 'Christopher Nolan',
    cast: [
      { name: 'Cillian Murphy', character: 'J. Robert Oppenheimer' },
      { name: 'Emily Blunt', character: 'Kitty Oppenheimer' },
      { name: 'Matt Damon', character: 'Leslie Groves' },
      { name: 'Robert Downey Jr.', character: 'Lewis Strauss' },
      { name: 'Florence Pugh', character: 'Jean Tatlock' },
    ],
    production: ['Universal Pictures', 'Syncopy'],
    posterPath: '/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg',
    backdropPath: '/fm6KqXpk3M2HVveHwCrBSSBaO0V.jpg',
    featured: true,
  },
  {
    tmdbId: 1184918,
    title: 'The Wild Robot',
    year: 2024,
    release: '2024-09-12',
    runtime: 102 * 60,
    rating: 8.2,
    votes: 4_100,
    genres: ['Animation', 'Science Fiction', 'Family'],
    overview:
      'A shipwrecked service robot learns to survive on a wild island, adopts an orphaned gosling, and quietly becomes the strangest parent the forest has ever seen.',
    director: 'Chris Sanders',
    cast: [
      { name: 'Lupita Nyong\'o', character: 'Roz' },
      { name: 'Pedro Pascal', character: 'Fink' },
      { name: 'Kit Connor', character: 'Brightbill' },
      { name: 'Bill Nighy', character: 'Longneck' },
    ],
    production: ['DreamWorks Animation'],
    posterPath: '/wTnV3PCVW5O92JMrFvvrRcV39RU.jpg',
    featured: true,
  },
  {
    tmdbId: 1022789,
    title: 'Inside Out 2',
    year: 2024,
    release: '2024-06-11',
    runtime: 96 * 60,
    rating: 7.6,
    votes: 5_300,
    genres: ['Animation', 'Family', 'Adventure'],
    overview:
      'Riley hits thirteen and headquarters gets a demolition crew: Anxiety moves in, brings friends, and starts redesigning the place before Joy can find the off switch.',
    director: 'Kelsey Mann',
    cast: [
      { name: 'Amy Poehler', character: 'Joy' },
      { name: 'Maya Hawke', character: 'Anxiety' },
      { name: 'Phyllis Smith', character: 'Sadness' },
      { name: 'Kensington Tallman', character: 'Riley' },
    ],
    production: ['Pixar'],
    posterPath: '/vpnVM9B6NMmQpWeZvzLvDESb2QY.jpg',
  },
  {
    tmdbId: 533535,
    title: 'Deadpool & Wolverine',
    year: 2024,
    release: '2024-07-24',
    runtime: 128 * 60,
    rating: 7.7,
    votes: 7_200,
    genres: ['Action', 'Comedy', 'Science Fiction'],
    overview:
      'The TVA drafts Wade Wilson to fix a dying timeline. He drafts the one Wolverine who hates him most, and the multiverse survives mostly by accident.',
    director: 'Shawn Levy',
    cast: [
      { name: 'Ryan Reynolds', character: 'Wade Wilson' },
      { name: 'Hugh Jackman', character: 'Logan' },
      { name: 'Emma Corrin', character: 'Cassandra Nova' },
      { name: 'Matthew Macfadyen', character: 'Paradox' },
    ],
    production: ['Marvel Studios', 'Maximum Effort'],
    posterPath: '/8cdWjvZQUExUUTzyp4t6EDMubfO.jpg',
  },
  {
    tmdbId: 569094,
    title: 'Spider-Man: Across the Spider-Verse',
    year: 2023,
    release: '2023-05-31',
    runtime: 140 * 60,
    rating: 8.4,
    votes: 7_600,
    genres: ['Animation', 'Action', 'Adventure'],
    overview:
      'Miles Morales crosses the multiverse, meets a society of Spider-People with rules about canon events, and decides his father\'s life is not a plot point.',
    director: 'Joaquim Dos Santos',
    cast: [
      { name: 'Shameik Moore', character: 'Miles Morales' },
      { name: 'Hailee Steinfeld', character: 'Gwen Stacy' },
      { name: 'Oscar Isaac', character: 'Miguel O\'Hara' },
      { name: 'Jason Schwartzman', character: 'Spot' },
    ],
    production: ['Sony Pictures Animation', 'Marvel Entertainment'],
    posterPath: '/8Vt6mWEReuy4Of61Lnj5Xj704m8.jpg',
    backdropPath: '/4HodYYKEIsGOdinkGi2Ucz6X9i0.jpg',
  },
  {
    tmdbId: 545611,
    title: 'Everything Everywhere All at Once',
    year: 2022,
    release: '2022-03-24',
    runtime: 139 * 60,
    rating: 7.8,
    votes: 8_900,
    genres: ['Action', 'Adventure', 'Science Fiction'],
    overview:
      'A laundromat owner discovers she is the only version of herself who can stop a multiversal collapse — starting with an IRS audit and ending with a bagel.',
    director: 'Daniel Kwan',
    cast: [
      { name: 'Michelle Yeoh', character: 'Evelyn Wang' },
      { name: 'Ke Huy Quan', character: 'Waymond Wang' },
      { name: 'Stephanie Hsu', character: 'Joy Wang' },
      { name: 'Jamie Lee Curtis', character: 'Deirdre Beaubeirdre' },
    ],
    production: ['A24', 'AGBO'],
    posterPath: '/w3LxiVYdWWRvEVdn5RYq6jIqkb1.jpg',
    backdropPath: '/ss0Os3uWJfQAENILHZUdX8Tt1OC.jpg',
  },
  {
    tmdbId: 346698,
    title: 'Barbie',
    year: 2023,
    release: '2023-07-19',
    runtime: 114 * 60,
    rating: 7.0,
    votes: 10_200,
    genres: ['Comedy', 'Adventure', 'Fantasy'],
    overview:
      'Barbie leaves the plastic perfection of Barbieland for the real world, discovers patriarchy, cellulite and the Mattel boardroom, and comes back with an argument about what a doll can be.',
    director: 'Greta Gerwig',
    cast: [
      { name: 'Margot Robbie', character: 'Barbie' },
      { name: 'Ryan Gosling', character: 'Ken' },
      { name: 'America Ferrera', character: 'Gloria' },
      { name: 'Kate McKinnon', character: 'Weird Barbie' },
    ],
    production: ['Warner Bros. Pictures', 'LuckyChap Entertainment'],
    posterPath: '/iuFNMS8U5cb6xfzi51Dbkovj7vM.jpg',
    backdropPath: '/nHf61UzkfFno5X1ofIhugCPus2R.jpg',
  },
  {
    tmdbId: 414906,
    title: 'The Batman',
    year: 2022,
    release: '2022-03-01',
    runtime: 176 * 60,
    rating: 7.7,
    votes: 10_400,
    genres: ['Crime', 'Mystery', 'Thriller'],
    overview:
      'Two years into his war on Gotham\'s rot, Batman follows a serial killer who leaves riddles pinned to bodies and a city\'s founding corruption underneath every answer.',
    director: 'Matt Reeves',
    cast: [
      { name: 'Robert Pattinson', character: 'Bruce Wayne' },
      { name: 'Zoë Kravitz', character: 'Selina Kyle' },
      { name: 'Paul Dano', character: 'Riddler' },
      { name: 'Colin Farrell', character: 'Penguin' },
    ],
    production: ['Warner Bros. Pictures', 'DC Films'],
    posterPath: '/74xTEgt7R36Fpooo50r9T25onhq.jpg',
    backdropPath: '/b0PlSFdDwbyK0cf5RxwDpaOJQvQ.jpg',
  },
  {
    tmdbId: 603692,
    title: 'John Wick: Chapter 4',
    year: 2023,
    release: '2023-03-24',
    runtime: 169 * 60,
    rating: 7.7,
    votes: 6_300,
    genres: ['Action', 'Thriller', 'Crime'],
    overview:
      'The bounty on John Wick goes global. He shoots his way through Paris, Osaka and Berlin to reach the one duel that can end the High Table\'s claim on him.',
    director: 'Chad Stahelski',
    cast: [
      { name: 'Keanu Reeves', character: 'John Wick' },
      { name: 'Donnie Yen', character: 'Caine' },
      { name: 'Bill Skarsgård', character: 'Marquis de Gramont' },
      { name: 'Ian McShane', character: 'Winston' },
    ],
    production: ['Lionsgate', 'Thunder Road'],
    posterPath: '/vZloFAK7NmvMGKE7VkF5UHaz0I.jpg',
    backdropPath: '/h8gHn0OzBoaefsYseUByqsmEDMY.jpg',
  },
  {
    tmdbId: 786892,
    title: 'Furiosa: A Mad Max Saga',
    year: 2024,
    release: '2024-05-22',
    runtime: 148 * 60,
    rating: 7.5,
    votes: 2_900,
    genres: ['Action', 'Adventure', 'Science Fiction'],
    overview:
      'Taken from the Green Place as a child, Furiosa spends fifteen years being traded, hunted and hardened before she gets close enough to Dementus to make it cost him.',
    director: 'George Miller',
    cast: [
      { name: 'Anya Taylor-Joy', character: 'Furiosa' },
      { name: 'Chris Hemsworth', character: 'Dementus' },
      { name: 'Tom Burke', character: 'Praetorian Jack' },
    ],
    production: ['Warner Bros. Pictures', 'Kennedy Miller Mitchell'],
    posterPath: '/iADOJ8Zymht2JPMoy3R7xceZprc.jpg',
  },
  {
    tmdbId: 653346,
    title: 'Kingdom of the Planet of the Apes',
    year: 2024,
    release: '2024-05-08',
    runtime: 145 * 60,
    rating: 7.1,
    votes: 2_600,
    genres: ['Science Fiction', 'Adventure', 'Action'],
    overview:
      'Generations after Caesar, a young ape leaves his clan to find out what the humans left behind — and whether the law "ape shall not kill ape" still means anything.',
    director: 'Wes Ball',
    cast: [
      { name: 'Owen Teague', character: 'Noa' },
      { name: 'Freya Allan', character: 'Mae' },
      { name: 'Kevin Durand', character: 'Proximus Caesar' },
    ],
    production: ['20th Century Studios'],
    posterPath: '/gKkl37BQuKTanygYQG1pyYgLVgf.jpg',
  },
  {
    tmdbId: 823464,
    title: 'Godzilla x Kong: The New Empire',
    year: 2024,
    release: '2024-03-28',
    runtime: 115 * 60,
    rating: 6.3,
    votes: 3_100,
    genres: ['Action', 'Science Fiction', 'Adventure'],
    overview:
      'Kong finds a hidden kingdom under the surface and something worse living in it. Godzilla charges up. The planet shakes. That is the plot and it is enough.',
    director: 'Adam Wingard',
    cast: [
      { name: 'Rebecca Hall', character: 'Ilene Andrews' },
      { name: 'Brian Tyree Henry', character: 'Bernie Hayes' },
      { name: 'Dan Stevens', character: 'Trapper' },
    ],
    production: ['Legendary Pictures', 'Warner Bros. Pictures'],
    posterPath: '/z1p34vh7dEOnLDmyCrlUVLuoDzd.jpg',
  },
  {
    tmdbId: 1011985,
    title: 'Kung Fu Panda 4',
    year: 2024,
    release: '2024-03-02',
    runtime: 94 * 60,
    rating: 6.6,
    votes: 2_200,
    genres: ['Animation', 'Action', 'Family'],
    overview:
      'Po is promoted to Spiritual Leader and has to pick a successor before a shape-shifting sorceress steals every master\'s kung fu in the valley.',
    director: 'Mike Mitchell',
    cast: [
      { name: 'Jack Black', character: 'Po' },
      { name: 'Awkwafina', character: 'Zhen' },
      { name: 'Viola Davis', character: 'The Chameleon' },
    ],
    production: ['DreamWorks Animation'],
    posterPath: '/kDp1vUBnMpe8ak4rjgl3cLELqjU.jpg',
  },
  {
    tmdbId: 912649,
    title: 'Venom: The Last Dance',
    year: 2024,
    release: '2024-10-22',
    runtime: 109 * 60,
    rating: 6.0,
    votes: 2_400,
    genres: ['Action', 'Science Fiction', 'Adventure'],
    overview:
      'Eddie and the symbiote are on the run from a creature hunting them across the country, with one last dance and a very ugly dog in the back seat.',
    director: 'Kelly Marcel',
    cast: [
      { name: 'Tom Hardy', character: 'Eddie Brock' },
      { name: 'Chiwetel Ejiofor', character: 'General Strickland' },
      { name: 'Juno Temple', character: 'Dr. Teddy Payne' },
    ],
    production: ['Sony Pictures', 'Marvel Entertainment'],
    posterPath: '/aosm8NMQ3UyoBVpSxyimorCQykC.jpg',
  },
  {
    tmdbId: 1241982,
    title: 'Moana 2',
    year: 2024,
    release: '2024-11-27',
    runtime: 100 * 60,
    rating: 6.7,
    votes: 1_900,
    genres: ['Animation', 'Adventure', 'Family'],
    overview:
      'A call from the ancestors sends Moana past the reef again, this time to reconnect the islands of the Pacific and talk Maui out of his own legend.',
    director: 'David Derrick Jr.',
    cast: [
      { name: 'Auli\'i Cravalho', character: 'Moana' },
      { name: 'Dwayne Johnson', character: 'Maui' },
    ],
    production: ['Walt Disney Animation Studios'],
    posterPath: '/aLVkiINlIeCkcZIzb7XHzPYgO6L.jpg',
  },
  {
    tmdbId: 426063,
    title: 'Nosferatu',
    year: 2024,
    release: '2024-12-25',
    runtime: 133 * 60,
    rating: 7.2,
    votes: 2_100,
    genres: ['Horror', 'Drama', 'Fantasy'],
    overview:
      'A young woman\'s marriage is haunted by the thing that has wanted her since before she could speak. Robert Eggers lights it by candle and lets it rot beautifully.',
    director: 'Robert Eggers',
    cast: [
      { name: 'Lily-Rose Depp', character: 'Ellen Hutter' },
      { name: 'Nicholas Hoult', character: 'Thomas Hutter' },
      { name: 'Bill Skarsgård', character: 'Count Orlok' },
      { name: 'Willem Dafoe', character: 'Professor Von Franz' },
    ],
    production: ['Focus Features', 'Regency Enterprises'],
    posterPath: '/5qGIxdEO841C0tdY8vOdLoRVrr0.jpg',
  },
  {
    tmdbId: 1012201,
    title: 'The Substance',
    year: 2024,
    release: '2024-09-07',
    runtime: 141 * 60,
    rating: 7.2,
    votes: 3_400,
    genres: ['Horror', 'Science Fiction', 'Drama'],
    overview:
      'A fading star buys a black-market serum that grows a younger, better version of her. The only rule is balance. The balance does not hold.',
    director: 'Coralie Fargeat',
    cast: [
      { name: 'Demi Moore', character: 'Elisabeth Sparkle' },
      { name: 'Margaret Qualley', character: 'Sue' },
      { name: 'Dennis Quaid', character: 'Harvey' },
    ],
    production: ['Working Title Films', 'Blacksmith'],
    posterPath: '/lqoMzCcZYEFK729d6qzt349fB4o.jpg',
  },
  {
    tmdbId: 1064213,
    title: 'Anora',
    year: 2024,
    release: '2024-10-14',
    runtime: 139 * 60,
    rating: 6.9,
    votes: 1_600,
    genres: ['Drama', 'Comedy', 'Romance'],
    overview:
      'A Brighton Beach dancer marries the son of an oligarch on a whim, then spends a very long night being un-married by three men in a black SUV.',
    director: 'Sean Baker',
    cast: [
      { name: 'Mikey Madison', character: 'Anora' },
      { name: 'Mark Eydelshteyn', character: 'Ivan' },
      { name: 'Yura Borisov', character: 'Igor' },
    ],
    production: ['Neon', 'FilmNation Entertainment'],
    posterPath: '/7MrgIUeq0DD2iF7GR6wqJfYZNeC.jpg',
  },
  {
    tmdbId: 438631,
    title: 'Dune',
    year: 2021,
    release: '2021-09-15',
    runtime: 155 * 60,
    rating: 7.8,
    votes: 12_600,
    genres: ['Science Fiction', 'Adventure'],
    overview:
      'House Atreides is handed the desert planet Arrakis and the spice that runs the universe. It is a gift with a knife behind it.',
    director: 'Denis Villeneuve',
    cast: [
      { name: 'Timothée Chalamet', character: 'Paul Atreides' },
      { name: 'Rebecca Ferguson', character: 'Lady Jessica' },
      { name: 'Oscar Isaac', character: 'Duke Leto' },
      { name: 'Zendaya', character: 'Chani' },
    ],
    production: ['Legendary Pictures', 'Warner Bros. Pictures'],
    posterPath: '/d5NXSklXo0qyIYkgV94XAgMIckC.jpg',
    backdropPath: '/jYEW5xZkZk2WTrdbMGAPFuBqbDc.jpg',
  },
  {
    tmdbId: 361743,
    title: 'Top Gun: Maverick',
    year: 2022,
    release: '2022-05-24',
    runtime: 130 * 60,
    rating: 8.2,
    votes: 9_600,
    genres: ['Action', 'Drama'],
    overview:
      'Maverick is back at Top Gun, this time teaching the mission that killed his best friend\'s son\'s father. He flies it himself because of course he does.',
    director: 'Joseph Kosinski',
    cast: [
      { name: 'Tom Cruise', character: 'Pete "Maverick" Mitchell' },
      { name: 'Miles Teller', character: 'Rooster' },
      { name: 'Jennifer Connelly', character: 'Penny Benjamin' },
      { name: 'Jon Hamm', character: 'Cyclone' },
    ],
    production: ['Paramount Pictures', 'Skydance'],
    posterPath: '/62HCnUTziyWcpDaBO2i1DX17ljH.jpg',
  },
  {
    tmdbId: 76600,
    title: 'Avatar: The Way of Water',
    year: 2022,
    release: '2022-12-14',
    runtime: 192 * 60,
    rating: 7.6,
    votes: 11_800,
    genres: ['Science Fiction', 'Adventure', 'Action'],
    overview:
      'The Sully family leaves the forest for the reefs of Pandora, learns to hold its breath, and finds out the sky people brought their grudge with them.',
    director: 'James Cameron',
    cast: [
      { name: 'Sam Worthington', character: 'Jake Sully' },
      { name: 'Zoe Saldaña', character: 'Neytiri' },
      { name: 'Sigourney Weaver', character: 'Kiri' },
      { name: 'Stephen Lang', character: 'Quaritch' },
    ],
    production: ['20th Century Studios', 'Lightstorm Entertainment'],
    posterPath: '/t6HIqrRAclMCA60NsSmeqe9RmNV.jpg',
  },
  {
    tmdbId: 76341,
    title: 'Mad Max: Fury Road',
    year: 2015,
    release: '2015-05-13',
    runtime: 120 * 60,
    rating: 7.6,
    votes: 9_900,
    genres: ['Action', 'Adventure', 'Science Fiction'],
    overview:
      'Furiosa steals a war rig and a harem and drives into the desert. Max is a hood ornament with a shotgun. The chase never really stops.',
    director: 'George Miller',
    cast: [
      { name: 'Tom Hardy', character: 'Max Rockatansky' },
      { name: 'Charlize Theron', character: 'Imperator Furiosa' },
      { name: 'Nicholas Hoult', character: 'Nux' },
    ],
    production: ['Warner Bros. Pictures', 'Kennedy Miller Mitchell'],
    posterPath: '/hA2ple9q4qnwxp3hKVNhroipsir.jpg',
  },
  {
    tmdbId: 286217,
    title: 'The Martian',
    year: 2015,
    release: '2015-09-30',
    runtime: 141 * 60,
    rating: 7.7,
    votes: 9_300,
    genres: ['Science Fiction', 'Drama', 'Adventure'],
    overview:
      'Left for dead on Mars, an astronaut turns botany, duct tape and sarcasm into a survival plan while NASA works out how to bring him home.',
    director: 'Ridley Scott',
    cast: [
      { name: 'Matt Damon', character: 'Mark Watney' },
      { name: 'Jessica Chastain', character: 'Commander Lewis' },
      { name: 'Chiwetel Ejiofor', character: 'Venkat Kapoor' },
    ],
    production: ['20th Century Studios', 'Scott Free'],
    posterPath: '/5BHuvQ6p9kfc091Z8RiFNhCwL4b.jpg',
  },
  {
    tmdbId: 329865,
    title: 'Arrival',
    year: 2016,
    release: '2016-11-10',
    runtime: 116 * 60,
    rating: 7.6,
    votes: 8_300,
    genres: ['Science Fiction', 'Drama', 'Mystery'],
    overview:
      'A linguist is asked to talk to the thing in the shell hovering over Montana. Learning its language means learning how time looks from the other side.',
    director: 'Denis Villeneuve',
    cast: [
      { name: 'Amy Adams', character: 'Louise Banks' },
      { name: 'Jeremy Renner', character: 'Ian Donnelly' },
      { name: 'Forest Whitaker', character: 'Colonel Weber' },
    ],
    production: ['FilmNation Entertainment', 'Lava Bear Films'],
    posterPath: '/x2FJsf1ElAgr63Y3PNPtJrcmpoe.jpg',
  },
  {
    tmdbId: 335984,
    title: 'Blade Runner 2049',
    year: 2017,
    release: '2017-10-04',
    runtime: 164 * 60,
    rating: 7.6,
    votes: 8_400,
    genres: ['Science Fiction', 'Drama', 'Mystery'],
    overview:
      'A blade runner uncovers a buried secret: a replicant gave birth. Chasing the answer leads him to a man who has been waiting thirty years to be asked.',
    director: 'Denis Villeneuve',
    cast: [
      { name: 'Ryan Gosling', character: 'K' },
      { name: 'Harrison Ford', character: 'Rick Deckard' },
      { name: 'Ana de Armas', character: 'Joi' },
      { name: 'Jared Leto', character: 'Niander Wallace' },
    ],
    production: ['Alcon Entertainment', 'Warner Bros. Pictures'],
    posterPath: '/gajva2L0rPYkEWjzgFlBXCAVBE5.jpg',
    backdropPath: '/ilRyazdMJwN05exqhwK4tMKBYZs.jpg',
  },
  {
    tmdbId: 496243,
    title: 'Parasite',
    year: 2019,
    release: '2019-05-30',
    runtime: 133 * 60,
    rating: 8.5,
    votes: 10_700,
    genres: ['Drama', 'Thriller', 'Comedy'],
    overview:
      'A poor family talks its way into a rich one, one job at a time, until the house shows them what is already living in the basement.',
    director: 'Bong Joon-ho',
    cast: [
      { name: 'Song Kang-ho', character: 'Ki-taek' },
      { name: 'Lee Sun-kyun', character: 'Mr. Park' },
      { name: 'Cho Yeo-jeong', character: 'Yeo-kyo' },
      { name: 'Choi Woo-shik', character: 'Ki-woo' },
    ],
    production: ['CJ Entertainment', 'Barunson E&A'],
    posterPath: '/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg',
    backdropPath: '/TU9NIjwzjoKPwQHoHshkFcQUCG.jpg',
  },
  {
    tmdbId: 244786,
    title: 'Whiplash',
    year: 2014,
    release: '2014-10-10',
    runtime: 107 * 60,
    rating: 8.4,
    votes: 9_800,
    genres: ['Drama', 'Music'],
    overview:
      'A drummer at the best conservatory in the country meets a teacher who believes genius is beaten out of a person. Neither of them can stop.',
    director: 'Damien Chazelle',
    cast: [
      { name: 'Miles Teller', character: 'Andrew Neiman' },
      { name: 'J.K. Simmons', character: 'Terence Fletcher' },
      { name: 'Paul Reiser', character: 'Jim Neiman' },
    ],
    production: ['Bold Films', 'Blumhouse'],
    posterPath: '/7fn624j5lj3xTme2SgiLCeuedmO.jpg',
  },
  {
    tmdbId: 27205,
    title: 'Inception',
    year: 2010,
    release: '2010-07-16',
    runtime: 148 * 60,
    rating: 8.4,
    votes: 14_300,
    genres: ['Science Fiction', 'Action', 'Thriller'],
    overview:
      'A thief who steals ideas from dreams is hired to plant one instead. The deeper the team goes, the less certain anyone is about which floor is real.',
    director: 'Christopher Nolan',
    cast: [
      { name: 'Leonardo DiCaprio', character: 'Cobb' },
      { name: 'Joseph Gordon-Levitt', character: 'Arthur' },
      { name: 'Elliot Page', character: 'Ariadne' },
      { name: 'Tom Hardy', character: 'Eames' },
    ],
    production: ['Warner Bros. Pictures', 'Legendary Pictures'],
    posterPath: '/9gk7adHYeDvHkCSEqAvQNLV5Uge.jpg',
    backdropPath: '/s3TBrRGB1iav7gFOCNx3H31MoES.jpg',
  },
  {
    tmdbId: 155,
    title: 'The Dark Knight',
    year: 2008,
    release: '2008-07-18',
    runtime: 152 * 60,
    rating: 8.5,
    votes: 16_400,
    genres: ['Drama', 'Action', 'Crime'],
    overview:
      'A clown with a plan proves that Gotham\'s white knight is one bad day from falling, and Batman has to decide what he is willing to be blamed for.',
    director: 'Christopher Nolan',
    cast: [
      { name: 'Christian Bale', character: 'Bruce Wayne' },
      { name: 'Heath Ledger', character: 'Joker' },
      { name: 'Aaron Eckhart', character: 'Harvey Dent' },
      { name: 'Gary Oldman', character: 'Gordon' },
    ],
    production: ['Warner Bros. Pictures', 'Legendary Pictures'],
    posterPath: '/qJ2tW6WMUDux911r6m7haRef0WH.jpg',
  },
  {
    tmdbId: 238,
    title: 'The Godfather',
    year: 1972,
    release: '1972-03-14',
    runtime: 175 * 60,
    rating: 8.7,
    votes: 13_100,
    genres: ['Drama', 'Crime'],
    overview:
      'The Corleone family moves its business from the old world to the new one while the youngest son, who wanted none of it, becomes all of it.',
    director: 'Francis Ford Coppola',
    cast: [
      { name: 'Marlon Brando', character: 'Don Vito Corleone' },
      { name: 'Al Pacino', character: 'Michael Corleone' },
      { name: 'James Caan', character: 'Sonny Corleone' },
    ],
    production: ['Paramount Pictures', 'Alfran Productions'],
    posterPath: '/3bhkrj58Vtu7enYsRolD1fZdja1.jpg',
  },
  {
    tmdbId: 278,
    title: 'The Shawshank Redemption',
    year: 1994,
    release: '1994-09-23',
    runtime: 142 * 60,
    rating: 8.7,
    votes: 27_000,
    genres: ['Drama', 'Crime'],
    overview:
      'A banker sentenced to life for a murder he did not commit spends two decades building a library, a friendship and a way out of Shawshank.',
    director: 'Frank Darabont',
    cast: [
      { name: 'Tim Robbins', character: 'Andy Dufresne' },
      { name: 'Morgan Freeman', character: 'Ellis Boyd Redding' },
      { name: 'Bob Gunton', character: 'Warden Norton' },
    ],
    production: ['Castle Rock Entertainment'],
    posterPath: '/q6y0Go1tsGEsmtFryDOJo3dEmqu.jpg',
  },
  {
    tmdbId: 550,
    title: 'Fight Club',
    year: 1999,
    release: '1999-10-15',
    runtime: 139 * 60,
    rating: 8.4,
    votes: 30_000,
    genres: ['Drama', 'Thriller'],
    overview:
      'An insomniac office worker and a soap salesman start a bare-knuckle club that turns into something much larger and much less under control.',
    director: 'David Fincher',
    cast: [
      { name: 'Edward Norton', character: 'The Narrator' },
      { name: 'Brad Pitt', character: 'Tyler Durden' },
      { name: 'Helena Bonham Carter', character: 'Marla Singer' },
    ],
    production: ['20th Century Fox', 'Regency Enterprises'],
    posterPath: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg',
  },
  {
    tmdbId: 13,
    title: 'Forrest Gump',
    year: 1994,
    release: '1994-06-23',
    runtime: 142 * 60,
    rating: 8.5,
    votes: 28_000,
    genres: ['Comedy', 'Drama', 'Romance'],
    overview:
      'A man with a slow heart keeps running straight through the second half of the American century and into the life of the girl he never stopped loving.',
    director: 'Robert Zemeckis',
    cast: [
      { name: 'Tom Hanks', character: 'Forrest Gump' },
      { name: 'Robin Wright', character: 'Jenny Curran' },
      { name: 'Gary Sinise', character: 'Lieutenant Dan' },
    ],
    production: ['Paramount Pictures'],
    posterPath: '/arw2vcBveWOVZr6pxd9XTd1TdQa.jpg',
  },
  {
    tmdbId: 603,
    title: 'The Matrix',
    year: 1999,
    release: '1999-03-30',
    runtime: 136 * 60,
    rating: 8.2,
    votes: 26_000,
    genres: ['Action', 'Science Fiction'],
    overview:
      'A hacker learns the world is a simulation and the people running it would rather he stayed plugged in. He takes the red pill anyway.',
    director: 'Lana Wachowski',
    cast: [
      { name: 'Keanu Reeves', character: 'Neo' },
      { name: 'Laurence Fishburne', character: 'Morpheus' },
      { name: 'Carrie-Anne Moss', character: 'Trinity' },
    ],
    production: ['Warner Bros. Pictures', 'Village Roadshow Pictures'],
    posterPath: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
  },
  {
    tmdbId: 769,
    title: 'Goodfellas',
    year: 1990,
    release: '1990-09-12',
    runtime: 145 * 60,
    rating: 8.5,
    votes: 13_000,
    genres: ['Crime', 'Drama'],
    overview:
      'Henry Hill grows up wanting to be a gangster, gets everything he wanted for twenty years, and then spends the rest of his life looking over his shoulder.',
    director: 'Martin Scorsese',
    cast: [
      { name: 'Ray Liotta', character: 'Henry Hill' },
      { name: 'Robert De Niro', character: 'Jimmy Conway' },
      { name: 'Joe Pesci', character: 'Tommy DeVito' },
    ],
    production: ['Warner Bros. Pictures'],
    posterPath: '/aKuFiU82s5ISJpGZp7YkIr3kCUd.jpg',
  },
  {
    tmdbId: 680,
    title: 'Pulp Fiction',
    year: 1994,
    release: '1994-09-10',
    runtime: 154 * 60,
    rating: 8.5,
    votes: 27_000,
    genres: ['Crime', 'Thriller'],
    overview:
      'Two hitmen, a boxer, a gangster\'s wife and a pair of diner robbers circle each other across one very long Los Angeles day.',
    director: 'Quentin Tarantino',
    cast: [
      { name: 'John Travolta', character: 'Vincent Vega' },
      { name: 'Samuel L. Jackson', character: 'Jules Winnfield' },
      { name: 'Uma Thurman', character: 'Mia Wallace' },
    ],
    production: ['Miramax', 'A Band Apart'],
    posterPath: '/d5iIlFn5s0ImszYzBPb8JPIfbXD.jpg',
  },
  {
    tmdbId: 274,
    title: 'The Silence of the Lambs',
    year: 1991,
    release: '1991-02-01',
    runtime: 119 * 60,
    rating: 8.3,
    votes: 15_000,
    genres: ['Crime', 'Thriller', 'Horror'],
    overview:
      'A trainee FBI agent trades pieces of herself for the help of one imprisoned cannibal, hoping to catch another killer before his basement runs out of room.',
    director: 'Jonathan Demme',
    cast: [
      { name: 'Jodie Foster', character: 'Clarice Starling' },
      { name: 'Anthony Hopkins', character: 'Hannibal Lecter' },
      { name: 'Scott Glenn', character: 'Jack Crawford' },
    ],
    production: ['Orion Pictures'],
    posterPath: '/uS9m8OBk1A8eM9I042bx8XXpqAq.jpg',
  },
  {
    tmdbId: 98,
    title: 'Gladiator',
    year: 2000,
    release: '2000-05-01',
    runtime: 155 * 60,
    rating: 8.2,
    votes: 17_000,
    genres: ['Action', 'Drama', 'Adventure'],
    overview:
      'A general betrayed by the emperor\'s son fights his way back through the arenas of Rome, one crowd at a time, toward the man who killed his family.',
    director: 'Ridley Scott',
    cast: [
      { name: 'Russell Crowe', character: 'Maximus' },
      { name: 'Joaquin Phoenix', character: 'Commodus' },
      { name: 'Connie Nielsen', character: 'Lucilla' },
    ],
    production: ['DreamWorks Pictures', 'Universal Pictures'],
    posterPath: '/ty8TGRuvJLPUmAR1H1nRIsgwvim.jpg',
  },
  {
    tmdbId: 597,
    title: 'Titanic',
    year: 1997,
    release: '1997-11-18',
    runtime: 194 * 60,
    rating: 7.9,
    votes: 25_000,
    genres: ['Drama', 'Romance'],
    overview:
      'A first-class girl and a steerage artist fall in love on the ship that everyone in the audience already knows is going to sink.',
    director: 'James Cameron',
    cast: [
      { name: 'Leonardo DiCaprio', character: 'Jack Dawson' },
      { name: 'Kate Winslet', character: 'Rose DeWitt Bukater' },
      { name: 'Billy Zane', character: 'Cal Hockley' },
    ],
    production: ['20th Century Fox', 'Paramount Pictures'],
    posterPath: '/9xjZS2rlVxm8SFx8kPC3aIGCOYQ.jpg',
  },
  {
    tmdbId: 1422,
    title: 'The Departed',
    year: 2006,
    release: '2006-10-05',
    runtime: 151 * 60,
    rating: 8.2,
    votes: 13_000,
    genres: ['Crime', 'Drama', 'Thriller'],
    overview:
      'A cop inside the mob and a mole inside the police both try to identify each other before Boston finishes killing everyone involved.',
    director: 'Martin Scorsese',
    cast: [
      { name: 'Leonardo DiCaprio', character: 'Billy Costigan' },
      { name: 'Matt Damon', character: 'Colin Sullivan' },
      { name: 'Jack Nicholson', character: 'Frank Costello' },
    ],
    production: ['Warner Bros. Pictures', 'Plan B Entertainment'],
    posterPath: '/nT97ifVT2J1yMQmeq20Qblg61T.jpg',
  },
  {
    tmdbId: 8587,
    title: 'The Lion King',
    year: 1994,
    release: '1994-06-15',
    runtime: 88 * 60,
    rating: 8.3,
    votes: 17_000,
    genres: ['Animation', 'Family', 'Drama'],
    overview:
      'A lion cub runs from the guilt of his father\'s death, grows up on bugs and philosophy, and comes back to take the rock from the uncle who set it up.',
    director: 'Roger Allers',
    cast: [
      { name: 'Matthew Broderick', character: 'Simba' },
      { name: 'James Earl Jones', character: 'Mufasa' },
      { name: 'Jeremy Irons', character: 'Scar' },
    ],
    production: ['Walt Disney Animation Studios'],
    posterPath: '/sKCr78MXSLixwmZ8DyJLrpMsd15.jpg',
  },
  {
    tmdbId: 679,
    title: 'Aliens',
    year: 1986,
    release: '1986-07-18',
    runtime: 137 * 60,
    rating: 8.0,
    votes: 9_400,
    genres: ['Action', 'Science Fiction', 'Horror'],
    overview:
      'Ripley goes back to the moon with a squad of marines and a loader exosuit. The colony is already gone. The queen is not.',
    director: 'James Cameron',
    cast: [
      { name: 'Sigourney Weaver', character: 'Ripley' },
      { name: 'Carrie Henn', character: 'Newt' },
      { name: 'Michael Biehn', character: 'Hicks' },
    ],
    production: ['20th Century Fox', 'Brandywine Productions'],
    posterPath: '/r1x5JGpyqZU8PYhbs4UcrO1Xb6x.jpg',
  },
  {
    tmdbId: 105,
    title: 'Back to the Future',
    year: 1985,
    release: '1985-07-03',
    runtime: 116 * 60,
    rating: 8.3,
    votes: 19_000,
    genres: ['Adventure', 'Comedy', 'Science Fiction'],
    overview:
      'A teenager drives a DeLorean thirty years into the past, accidentally stops his parents from meeting, and has one week and one lightning bolt to fix it.',
    director: 'Robert Zemeckis',
    cast: [
      { name: 'Michael J. Fox', character: 'Marty McFly' },
      { name: 'Christopher Lloyd', character: 'Doc Brown' },
      { name: 'Lea Thompson', character: 'Lorraine' },
    ],
    production: ['Universal Pictures', 'Amblin Entertainment'],
    posterPath: '/fNOH9f1aA7XRTzl1sAOx9iF553Q.jpg',
  },
  {
    tmdbId: 24428,
    title: 'The Avengers',
    year: 2012,
    release: '2012-04-25',
    runtime: 143 * 60,
    rating: 7.7,
    votes: 30_000,
    genres: ['Action', 'Science Fiction', 'Adventure'],
    overview:
      'Six heroes who cannot share a room are the only thing standing between an alien army and Manhattan. The room-sharing is the hard part.',
    director: 'Joss Whedon',
    cast: [
      { name: 'Robert Downey Jr.', character: 'Tony Stark' },
      { name: 'Chris Evans', character: 'Steve Rogers' },
      { name: 'Scarlett Johansson', character: 'Natasha Romanoff' },
    ],
    production: ['Marvel Studios'],
    posterPath: '/RYMX2wcKCBAr24UyPD7xwmjaTn.jpg',
  },
  {
    tmdbId: 299536,
    title: 'Avengers: Infinity War',
    year: 2018,
    release: '2018-04-24',
    runtime: 149 * 60,
    rating: 8.2,
    votes: 30_000,
    genres: ['Action', 'Adventure', 'Science Fiction'],
    overview:
      'Thanos comes for the stones and wins. The film spends two and a half hours showing a group of heroes learning that being right is not the same as being able.',
    director: 'Anthony Russo',
    cast: [
      { name: 'Robert Downey Jr.', character: 'Tony Stark' },
      { name: 'Chris Hemsworth', character: 'Thor' },
      { name: 'Josh Brolin', character: 'Thanos' },
    ],
    production: ['Marvel Studios'],
    posterPath: '/7WsyChQLEftFiDOVTGkv3hFpyyt.jpg',
  },
  {
    tmdbId: 299534,
    title: 'Avengers: Endgame',
    year: 2019,
    release: '2019-04-24',
    runtime: 181 * 60,
    rating: 8.2,
    votes: 26_000,
    genres: ['Adventure', 'Science Fiction', 'Action'],
    overview:
      'Five years after the snap, a rat, a time heist and a very large hammer put the surviving Avengers back in the room where it started.',
    director: 'Anthony Russo',
    cast: [
      { name: 'Robert Downey Jr.', character: 'Tony Stark' },
      { name: 'Chris Evans', character: 'Steve Rogers' },
      { name: 'Mark Ruffalo', character: 'Bruce Banner' },
    ],
    production: ['Marvel Studios'],
    posterPath: '/or06FN3Dka5tukK1e9sl16pB3iy.jpg',
  },
  {
    tmdbId: 1726,
    title: 'Iron Man',
    year: 2008,
    release: '2008-04-30',
    runtime: 126 * 60,
    rating: 7.6,
    votes: 26_000,
    genres: ['Action', 'Science Fiction', 'Adventure'],
    overview:
      'A weapons dealer builds a suit in a cave, comes home, and discovers the only thing harder than building the suit is being the kind of man who deserves it.',
    director: 'Jon Favreau',
    cast: [
      { name: 'Robert Downey Jr.', character: 'Tony Stark' },
      { name: 'Gwyneth Paltrow', character: 'Pepper Potts' },
      { name: 'Jeff Bridges', character: 'Obadiah Stane' },
    ],
    production: ['Marvel Studios', 'Paramount Pictures'],
    posterPath: '/78lPtwv72eTNqFW9COBYI0dWDJa.jpg',
  },
  {
    tmdbId: 284054,
    title: 'Black Panther',
    year: 2018,
    release: '2018-02-13',
    runtime: 135 * 60,
    rating: 7.3,
    votes: 23_000,
    genres: ['Action', 'Adventure', 'Science Fiction'],
    overview:
      'A new king inherits a hidden country and an old lie. The cousin he never knew makes him choose between the throne and the point of the throne.',
    director: 'Ryan Coogler',
    cast: [
      { name: 'Chadwick Boseman', character: 'T\'Challa' },
      { name: 'Michael B. Jordan', character: 'Killmonger' },
      { name: 'Lupita Nyong\'o', character: 'Nakia' },
    ],
    production: ['Marvel Studios'],
    posterPath: '/uxzzxijgPIY7slzFvMotPv8wjKA.jpg',
  },
  {
    tmdbId: 475557,
    title: 'Joker',
    year: 2019,
    release: '2019-10-01',
    runtime: 122 * 60,
    rating: 8.2,
    votes: 25_000,
    genres: ['Crime', 'Thriller', 'Drama'],
    overview:
      'A failed comedian keeps getting kicked down the stairs of Gotham until he decides the stairs were the point and the city should try laughing.',
    director: 'Todd Phillips',
    cast: [
      { name: 'Joaquin Phoenix', character: 'Arthur Fleck' },
      { name: 'Robert De Niro', character: 'Murray Franklin' },
      { name: 'Zazie Beetz', character: 'Sophie Dumond' },
    ],
    production: ['Warner Bros. Pictures', 'DC Films'],
    posterPath: '/udDclJoHjfjb8Ekgsd4FDteOkCU.jpg',
  },
  {
    tmdbId: 37799,
    title: 'The Social Network',
    year: 2010,
    release: '2010-10-01',
    runtime: 121 * 60,
    rating: 7.4,
    votes: 12_000,
    genres: ['Drama'],
    overview:
      'A student builds a website about who is dating whom, then spends the next six years in depositions with everyone who helped him do it.',
    director: 'David Fincher',
    cast: [
      { name: 'Jesse Eisenberg', character: 'Mark Zuckerberg' },
      { name: 'Andrew Garfield', character: 'Eduardo Saverin' },
      { name: 'Armie Hammer', character: 'Cameron Winklevoss' },
    ],
    production: ['Columbia Pictures', 'Scott Rudin Productions'],
    posterPath: '/n0ybibhJtQ5icDqTp8eRytcIHJx.jpg',
  },
  {
    tmdbId: 313369,
    title: 'La La Land',
    year: 2016,
    release: '2016-12-08',
    runtime: 128 * 60,
    rating: 8.0,
    votes: 15_000,
    genres: ['Romance', 'Drama', 'Music'],
    overview:
      'A jazz purist and an actress fall in love in Los Angeles and then keep choosing the work over the lover, one audition at a time.',
    director: 'Damien Chazelle',
    cast: [
      { name: 'Ryan Gosling', character: 'Sebastian' },
      { name: 'Emma Stone', character: 'Mia' },
      { name: 'John Legend', character: 'Keith' },
    ],
    production: ['Lionsgate', 'Summit Entertainment'],
    posterPath: '/uDO8zWDhfWwoFdKS4fzkUJt0Rf0.jpg',
  },
  {
    tmdbId: 419430,
    title: 'Get Out',
    year: 2017,
    release: '2017-02-24',
    runtime: 104 * 60,
    rating: 7.6,
    votes: 14_000,
    genres: ['Horror', 'Thriller', 'Mystery'],
    overview:
      'A weekend with his girlfriend\'s family goes from awkward to surgical as Chris realises the smiles are not hospitality, they are inventory.',
    director: 'Jordan Peele',
    cast: [
      { name: 'Daniel Kaluuya', character: 'Chris Washington' },
      { name: 'Allison Williams', character: 'Rose Armitage' },
      { name: 'Catherine Keener', character: 'Missy Armitage' },
    ],
    production: ['Blumhouse', 'Universal Pictures'],
    posterPath: '/tFXcEccSQMf3lfhfXKSU9iRBpa3.jpg',
  },
  {
    tmdbId: 546554,
    title: 'Knives Out',
    year: 2019,
    release: '2019-11-27',
    runtime: 130 * 60,
    rating: 7.9,
    votes: 16_000,
    genres: ['Comedy', 'Crime', 'Mystery'],
    overview:
      'A detective with a linen coat unpicks a rich family\'s alibis while the nurse at the centre of the will quietly holds every card.',
    director: 'Rian Johnson',
    cast: [
      { name: 'Daniel Craig', character: 'Benoit Blanc' },
      { name: 'Ana de Armas', character: 'Marta Cabrera' },
      { name: 'Chris Evans', character: 'Ransom Drysdale' },
    ],
    production: ['Lionsgate', 'Media Rights Capital'],
    posterPath: '/pThyQovXQrw2m0s9x82twj48Jq4.jpg',
  },
  {
    tmdbId: 68718,
    title: 'Django Unchained',
    year: 2012,
    release: '2012-12-25',
    runtime: 165 * 60,
    rating: 8.2,
    votes: 17_000,
    genres: ['Drama', 'Western'],
    overview:
      'A freed slave and a bounty hunter ride south to buy back a wife who is not for sale, and settle the bill with a very loud receipt.',
    director: 'Quentin Tarantino',
    cast: [
      { name: 'Jamie Foxx', character: 'Django' },
      { name: 'Christoph Waltz', character: 'Dr. King Schultz' },
      { name: 'Leonardo DiCaprio', character: 'Calvin Candie' },
    ],
    production: ['The Weinstein Company', 'Columbia Pictures'],
    posterPath: '/7oWY8VDWW7thTzWh3OKYRkWUlD5.jpg',
  },
  {
    tmdbId: 16869,
    title: 'Inglourious Basterds',
    year: 2009,
    release: '2009-08-19',
    runtime: 153 * 60,
    rating: 8.2,
    votes: 15_000,
    genres: ['Drama', 'Thriller', 'War'],
    overview:
      'A squad of Jewish-American soldiers scalps Nazis across occupied France while a cinema owner quietly prepares the last premiere the Reich will ever attend.',
    director: 'Quentin Tarantino',
    cast: [
      { name: 'Brad Pitt', character: 'Aldo Raine' },
      { name: 'Christoph Waltz', character: 'Hans Landa' },
      { name: 'Mélanie Laurent', character: 'Shosanna' },
    ],
    production: ['Universal Pictures', 'A Band Apart'],
    posterPath: '/7sfbEnaARXDDhKm0CZ7D7uc2sbo.jpg',
  },
  {
    tmdbId: 466272,
    title: 'Once Upon a Time in Hollywood',
    year: 2019,
    release: '2019-07-25',
    runtime: 162 * 60,
    rating: 7.6,
    votes: 15_000,
    genres: ['Comedy', 'Drama', 'Thriller'],
    overview:
      'A fading TV cowboy, his stunt double and a pregnant actress live next door to a murder that has not happened yet. Tarantino rewrites the ending again.',
    director: 'Quentin Tarantino',
    cast: [
      { name: 'Leonardo DiCaprio', character: 'Rick Dalton' },
      { name: 'Brad Pitt', character: 'Cliff Booth' },
      { name: 'Margot Robbie', character: 'Sharon Tate' },
    ],
    production: ['Columbia Pictures', 'Heyday Films'],
    posterPath: '/8j58iEBw9pOXFD2L0nt0ZXeHviB.jpg',
  },
  {
    tmdbId: 281957,
    title: 'The Revenant',
    year: 2015,
    release: '2015-12-25',
    runtime: 156 * 60,
    rating: 7.5,
    votes: 18_000,
    genres: ['Western', 'Drama', 'Adventure'],
    overview:
      'A frontiersman is mauled by a bear, buried alive and left for dead. He crawls back across a frozen continent for the man who did the leaving.',
    director: 'Alejandro G. Iñárritu',
    cast: [
      { name: 'Leonardo DiCaprio', character: 'Hugh Glass' },
      { name: 'Tom Hardy', character: 'John Fitzgerald' },
      { name: 'Domhnall Gleeson', character: 'Henry' },
    ],
    production: ['20th Century Fox', 'Regency Enterprises'],
    posterPath: '/ji3ecJphATlVgWNY0B0RVXZizdf.jpg',
  },
  {
    tmdbId: 120467,
    title: 'The Grand Budapest Hotel',
    year: 2014,
    release: '2014-02-26',
    runtime: 100 * 60,
    rating: 8.0,
    votes: 13_000,
    genres: ['Comedy', 'Drama', 'Crime'],
    overview:
      'A concierge and his lobby boy inherit a painting, a murder charge and a collapsing continent, all arranged in perfectly symmetrical frames.',
    director: 'Wes Anderson',
    cast: [
      { name: 'Ralph Fiennes', character: 'M. Gustave' },
      { name: 'Tony Revolori', character: 'Zero' },
      { name: 'Saoirse Ronan', character: 'Agatha' },
    ],
    production: ['Fox Searchlight Pictures', 'Indian Paintbrush'],
    posterPath: '/eWdyYQreja6JGCzqHWXpWHDrrPo.jpg',
  },
  {
    tmdbId: 530915,
    title: '1917',
    year: 2019,
    release: '2019-12-25',
    runtime: 119 * 60,
    rating: 8.0,
    votes: 12_000,
    genres: ['War', 'Drama', 'Action'],
    overview:
      'Two runners cross No Man\'s Land in what looks like a single shot to tell a colonel to call off an attack that will kill sixteen hundred men.',
    director: 'Sam Mendes',
    cast: [
      { name: 'George MacKay', character: 'Schofield' },
      { name: 'Dean-Charles Chapman', character: 'Blake' },
      { name: 'Benedict Cumberbatch', character: 'Colonel Mackenzie' },
    ],
    production: ['Universal Pictures', 'DreamWorks Pictures'],
    posterPath: '/iZf0KyrE25z1sage4SYFLCCrMi9.jpg',
  },
  {
    tmdbId: 324786,
    title: 'Hacksaw Ridge',
    year: 2016,
    release: '2016-11-04',
    runtime: 139 * 60,
    rating: 7.5,
    votes: 12_000,
    genres: ['Drama', 'War', 'History'],
    overview:
      'A combat medic who refuses to carry a rifle walks into the bloodiest ridge of the Pacific war and lowers seventy-five men down a cliff on a rope.',
    director: 'Mel Gibson',
    cast: [
      { name: 'Andrew Garfield', character: 'Desmond Doss' },
      { name: 'Sam Worthington', character: 'Captain Glover' },
      { name: 'Vince Vaughn', character: 'Sergeant Howell' },
    ],
    production: ['Summit Entertainment', 'Cross Creek Pictures'],
    posterPath: '/aYcnDyLMnpKce1FOYUpZrXtgUye.jpg',
  },
  {
    tmdbId: 577922,
    title: 'Tenet',
    year: 2020,
    release: '2020-08-22',
    runtime: 150 * 60,
    rating: 7.3,
    votes: 9_800,
    genres: ['Action', 'Thriller', 'Science Fiction'],
    overview:
      'A unnamed operative learns to move backwards through time and has to hold a whole inverted battle in his head at once. Do not try to understand it. Feel it.',
    director: 'Christopher Nolan',
    cast: [
      { name: 'John David Washington', character: 'The Protagonist' },
      { name: 'Robert Pattinson', character: 'Neil' },
      { name: 'Elizabeth Debicki', character: 'Kat' },
    ],
    production: ['Warner Bros. Pictures', 'Syncopy'],
    posterPath: '/k68nPLbIST6NP96JmTxmZijEvCA.jpg',
  },
  {
    tmdbId: 77,
    title: 'Memento',
    year: 2000,
    release: '2000-10-11',
    runtime: 113 * 60,
    rating: 8.1,
    votes: 12_000,
    genres: ['Mystery', 'Thriller'],
    overview:
      'A man who cannot form new memories hunts his wife\'s killer using tattoos and Polaroids, while the film runs the story backwards to meet him.',
    director: 'Christopher Nolan',
    cast: [
      { name: 'Guy Pearce', character: 'Leonard Shelby' },
      { name: 'Carrie-Anne Moss', character: 'Natalie' },
      { name: 'Joe Pantoliano', character: 'Teddy' },
    ],
    production: ['Newmarket Films', 'Summit Entertainment'],
    posterPath: '/yuNs09hvpHVU1cBTCAk9zxsL2oW.jpg',
  },
  {
    tmdbId: 64690,
    title: 'Drive',
    year: 2011,
    release: '2011-09-15',
    runtime: 100 * 60,
    rating: 7.6,
    votes: 8_900,
    genres: ['Crime', 'Drama', 'Thriller'],
    overview:
      'A stunt driver moonlights as a getaway wheelman, falls for his neighbour, and then takes a job that puts a hammer through every quiet plan he had.',
    director: 'Nicolas Winding Refn',
    cast: [
      { name: 'Ryan Gosling', character: 'Driver' },
      { name: 'Carey Mulligan', character: 'Irene' },
      { name: 'Bryan Cranston', character: 'Shannon' },
    ],
    production: ['FilmDistrict', 'Bold Films'],
    posterPath: '/602vevIURmpDfzbnv5Ubi6wIkQm.jpg',
  },
  {
    tmdbId: 245891,
    title: 'John Wick',
    year: 2014,
    release: '2014-10-22',
    runtime: 101 * 60,
    rating: 7.4,
    votes: 17_000,
    genres: ['Action', 'Thriller'],
    overview:
      'Retired hitman loses his wife, gets a puppy, loses the puppy, and goes back to work with a very specific list and no interest in negotiating.',
    director: 'Chad Stahelski',
    cast: [
      { name: 'Keanu Reeves', character: 'John Wick' },
      { name: 'Michael Nyqvist', character: 'Viggo Tarasov' },
      { name: 'Alfie Allen', character: 'Iosef Tarasov' },
    ],
    production: ['Lionsgate', 'Thunder Road'],
    posterPath: '/fZPSd91yGE9fCcCe6OoQr6E3Bev.jpg',
  },
];

/**
 * Three shelves, one catalog. Later shelves can repeat a title that an earlier
 * shelf already ships (a favourite resurfacing in a different genre pass), so
 * the merge keeps the first record per TMDB id and drops the rest — otherwise
 * the grid shows the same film twice and the id map points at a stale object.
 */
const FILMS = (() => {
  const seen = new Map();
  for (const film of [...BASE_FILMS, ...EXTRA_FILMS, ...MORE_FILMS, ...DEEP_FILMS]) {
    const id = Number(film.tmdbId);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.set(id, film);
  }
  return [...seen.values()];
})();

function normalize(film) {
  return {
    id: `tmdb:${film.tmdbId}`,
    source: 'tmdb',
    sourceKind: 'curated',
    tmdbId: film.tmdbId,
    title: film.title,
    originalTitle: null,
    year: film.year,
    release: film.release,
    overview: film.overview,
    rating: film.rating ?? null,
    votes: film.votes ?? null,
    popularity: film.popularity ?? 0,
    genres: film.genres ?? [],
    genreIds: [],
    poster: art(film.posterUrl ?? film.posterPath, 'w500'),
    backdrop: art(film.backdropUrl ?? film.backdropPath, 'w1280'),
    badge: 'HD',
    sources: embedSources(film.tmdbId),
  };
}

const ITEMS = FILMS.map(normalize);

/** Newest first — the order the home shelf and the "newest" sort use. */
export const CURATED_ITEMS = [...ITEMS].sort((a, b) => String(b.release).localeCompare(String(a.release)));

const FEATURED = FILMS.filter((film) => film.featured).map((film) => film.tmdbId);

const BY_ID = new Map(ITEMS.map((item) => [item.tmdbId, item]));

const normalizeName = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export function curatedItems() {
  return CURATED_ITEMS;
}

/** The hero shelf: the hand-picked fan favourites that carry the site. */
export function curatedFeatured() {
  return FEATURED.map((id) => BY_ID.get(id)).filter(Boolean);
}

export function isCurated(tmdbId) {
  return BY_ID.has(Number(tmdbId));
}

export function curatedSearch(query) {
  const term = normalizeName(query);
  if (!term) return [];
  const words = term.split(' ').filter(Boolean);
  // A five-character prefix is enough to survive the way people actually type
  // "interstelar" at 1am without turning the shelf into a fuzzy mess. It only
  // ever runs against the title — a stem over the whole haystack made "menta"
  // match every documentary on the shelf.
  const stem = term.slice(0, 5);
  const scored = [];
  for (const film of FILMS) {
    const item = BY_ID.get(film.tmdbId);
    const title = normalizeName(film.title);
    const haystack = normalizeName(
      [film.title, film.director, String(film.year), ...(film.genres ?? [])].join(' '),
    );

    let score = 0;
    if (title === term) score = 400;
    else if (title.startsWith(term)) score = 320;
    else if (title.includes(term)) score = 260;
    else if (haystack.includes(term)) score = 150;
    else if (words.length > 1 && words.every((word) => title.includes(word))) score = 220;
    else if (words.every((word) => haystack.includes(word))) score = 120;
    else if (stem.length >= 4 && title.includes(stem)) score = 60;

    if (score) scored.push({ item, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || (b.item.rating ?? 0) - (a.item.rating ?? 0))
    .map((entry) => entry.item);
}

/** Full detail payload shaped like catalog.detail() so the modal renders blind. */
export function curatedDetail(tmdbId) {
  const id = Number(tmdbId);
  const film = FILMS.find((entry) => entry.tmdbId === id);
  if (!film) return null;
  const item = BY_ID.get(id);
  const similar = CURATED_ITEMS
    .filter((other) => other.id !== item.id)
    .sort((a, b) => {
      const overlap = (entry) => (entry.genres ?? []).filter((genre) => film.genres?.includes(genre)).length;
      return overlap(b) - overlap(a) || (b.rating ?? 0) - (a.rating ?? 0);
    })
    .slice(0, 12);

  return {
    ...item,
    runtime: film.runtime ?? null,
    tagline: film.tagline ?? null,
    status: 'Released',
    releaseDate: film.release,
    genres: film.genres ?? [],
    production: film.production ?? [],
    directors: film.director ? [film.director] : [],
    cast: (film.cast ?? []).map((person) => ({ name: person.name, character: person.character, photo: null })),
    trailer: null,
    sources: embedSources(id),
    similar,
    stream: null,
  };
}
