const http = require('http');

const HOST = 'localhost';
const PORT = 3000;

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: HOST,
      port: PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(chunks) }); }
        catch { resolve({ status: res.statusCode, data: chunks }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randomDOB() {
  const year = randInt(1990, 2004);
  const month = String(randInt(1, 12)).padStart(2, '0');
  const day = String(randInt(1, 28)).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const maleNames = [
  'Ahmed','Mohamed','Ali','Omar','Youssef','Khaled','Hassan','Ibrahim','Tariq','Sami',
  'John','David','Michael','Chris','Alex','Ryan','Kevin','Jason','Brian','Tyler',
  'Luca','Matteo','Marco','Stefano','Giovanni','Carlos','Diego','Pablo','Sergio','Miguel',
  'Liam','Noah','Ethan','Lucas','James','William','Benjamin','Daniel','Henry','Sebastian',
  'Yuki','Kenji','Haruto','Ryo','Takeshi','Arjun','Raj','Vikram','Priam','Dev',
  'Hans','Friedrich','Karl','Stefan','Andre','Pierre','Jean','Louis','Pierre','Antoine',
  'Ivan','Dmitri','Sergei','Alexei','Vladimir','Oliver','George','Harry','Jack','Charlie',
  'Felix','Maximilian','Leon','Finn','Emil','Anders','Lars','Magnus','Erik','Oscar',
  'Bruno','Rafael','Gonzalo','Javier','Andres','Tariq','Nasser','Rashid','Saeed','Bilal',
];

const femaleNames = [
  'Fatima','Aisha','Noor','Layla','Yasmin','Salma','Mona','Hana','Dina','Reem',
  'Sarah','Jessica','Emily','Ashley','Amanda','Stephanie','Nicole','Rachel','Laura','Megan',
  'Sofia','Giulia','Chiara','Elena','Valentina','Isabella','Camila','Valentina','Lucia','Maria',
  'Olivia','Emma','Charlotte','Amelia','Harper','Evelyn','Abigail','Mia','Ella','Aria',
  'Yui','Sakura','Hana','Mei','Rin','Ananya','Priya','Nisha','Kavya','Meera',
  'Anna','Sophie','Marie','Julia','Lea','Mia','Emma','Lena','Clara','Hannah',
  'Anastasia','Marina','Katya','Nadia','Olga','Eva','Sara','Laura','Carmen','Paula',
  'Zoe','Lily','Chloe','Grace','Ruby','Iris','Stella','Nora','Hazel','Luna',
];

const bios = {
  male: [
    'Living my best life. Coffee, gym, repeat.',
    'Adventure seeker. Let\'s explore the world together.',
    'Foodie at heart. I cook better than I look.',
    'Music is my therapy. Guitar player & singer.',
    'Entrepreneur building the future, one day at a time.',
    'Dog dad. Swipe right if you love golden retrievers.',
    'Fitness enthusiast. Your gym buddy awaits.',
    'Travel addict. 30 countries and counting.',
    'Tech nerd with a soul. Software engineer by day.',
    'Photographer capturing moments. Let me capture yours.',
    'Nature lover. Hiking, camping, stargazing.',
    'Bookworm who also loves nightlife. Best of both worlds.',
    'Former athlete, current foodie. No regrets.',
    'Dreamer with a plan. Working on something big.',
    'Simply looking for genuine connection.',
    'I make the best pasta in town. Challenge me.',
    'Sunset chaser and morning coffee ritualist.',
    'Part-time DJ, full-time gentleman.',
    'Your future travel buddy. Just saying.',
    'I believe in good vibes and great conversations.',
  ],
  female: [
    'Plant mom living in a jungle apartment.',
    'Yoga instructor with a sweet tooth. Balance is key.',
    'Dancing through life, one step at a time.',
    'Sunset lover. Always chasing golden hour.',
    'Coffee first, everything else second.',
    'Art teacher by day, Netflix binger by night.',
    'Passport full, heart open. Where to next?',
    'Bookworm with a wanderlust soul.',
    'Making the world prettier, one painting at a time.',
    'Dog mom. My golden retriever approves all matches.',
    'Fitness lover. Strong is the new beautiful.',
    'Foodie exploring every restaurant in town.',
    'Music festival enthusiast. Next one is on me.',
    'Simple girl with big dreams.',
    'I speak fluently in sarcasm and kindness.',
    'Looking for someone who laughs at my jokes.',
    'Wine lover and cheese enthusiast. The perfect combo.',
    'Beach bum with a corporate job. Weekends are sacred.',
    'Believe in magic, kindness, and good coffee.',
    'Adventure is out there. Let\'s find it together.',
  ],
};

const countries = [
  { code: 'SA', lat: [24.7, 24.8], lng: [46.6, 46.8] },
  { code: 'AE', lat: [25.1, 25.3], lng: [55.2, 55.4] },
  { code: 'EG', lat: [30.0, 30.1], lng: [31.2, 31.4] },
  { code: 'MA', lat: [33.5, 33.7], lng: [-7.6, -7.5] },
  { code: 'TR', lat: [41.0, 41.1], lng: [28.9, 29.1] },
  { code: 'LB', lat: [33.8, 33.9], lng: [35.5, 35.6] },
  { code: 'JO', lat: [31.9, 32.0], lng: [35.9, 36.0] },
  { code: 'US', lat: [34.0, 40.7], lng: [-118.2, -74.0] },
  { code: 'GB', lat: [51.5, 55.9], lng: [-0.1, -3.2] },
  { code: 'FR', lat: [48.8, 43.3], lng: [2.3, 5.4] },
  { code: 'DE', lat: [52.5, 50.1], lng: [13.4, 8.7] },
  { code: 'IT', lat: [41.9, 45.4], lng: [12.5, 9.2] },
  { code: 'ES', lat: [40.4, 41.4], lng: [-3.7, 2.2] },
  { code: 'JP', lat: [35.6, 34.7], lng: [139.7, 135.5] },
  { code: 'KR', lat: [37.5, 35.2], lng: [127.0, 129.0] },
  { code: 'BR', lat: [-23.5, -22.9], lng: [-46.6, -43.2] },
  { code: 'IN', lat: [28.6, 19.1], lng: [77.2, 72.9] },
  { code: 'AU', lat: [-33.8, -37.8], lng: [151.2, 144.9] },
  { code: 'CA', lat: [43.6, 49.3], lng: [-79.4, -123.1] },
  { code: 'SE', lat: [59.3, 57.7], lng: [18.1, 12.0] },
];

const languages = {
  SA: 'ar', AE: 'ar', EG: 'ar', MA: 'ar', LB: 'ar', JO: 'ar',
  TR: 'tr', US: 'en', GB: 'en', AU: 'en', CA: 'en', IN: 'en',
  FR: 'fr', DE: 'de', IT: 'it', ES: 'es', JP: 'ja', KR: 'ko',
  BR: 'pt', SE: 'en',
};

const biosMale = bios.male;
const biosFemale = bios.female;

async function main() {
  console.log('Seeding 100 users...\n');
  let count = 0;
  let failed = 0;

  for (let i = 0; i < 100; i++) {
    const gender = i % 2 === 0 ? 'male' : 'female';
    const name = gender === 'male' ? pick(maleNames) : pick(femaleNames);
    const country = pick(countries);
    const suffix = randInt(100, 999);
    const email = `${name.toLowerCase()}${suffix}@test.com`;
    const username = `${name.toLowerCase()}${suffix}`;
    const dob = randomDOB();
    const lat = randInt(country.lat[0] * 1000, country.lat[1] * 1000) / 1000 + (Math.random() * 0.1 - 0.05);
    const lng = randInt(country.lng[0] * 1000, country.lng[1] * 1000) / 1000 + (Math.random() * 0.1 - 0.05);
    const bio = pick(gender === 'male' ? biosMale : biosFemale);
    const avatarId = randInt(100, 9999);

    // 1. Register
    const reg = await api('POST', '/auth/register', {
      email,
      password: 'Test1234@',
      username,
      full_name: name,
      gender,
      country_code: country.code,
      date_of_birth: dob,
    });

    if (reg.status === 409) {
      console.log(`[${i + 1}/100] Skip ${name} — exists`);
      continue;
    }
    if (reg.status !== 201) {
      console.log(`[${i + 1}/100] FAIL ${name}: ${reg.data?.error || JSON.stringify(reg.data)}`);
      failed++;
      continue;
    }

    const token = reg.data.access_token;

    // 2. Complete profile
    await api('PUT', '/profile', {
      bio,
      education_level: pick(['high_school', 'bachelor', 'master', 'phd']),
      work_status: pick(['student', 'employed', 'self_employed']),
      is_smoker: Math.random() > 0.7 ? 'yes' : 'no',
      drinks_alcohol: pick(['never', 'sometimes', 'often', 'socially']),
      children_count: Math.random() > 0.85 ? 1 : 0,
      relationship_status: pick(['single', 'divorced', 'widowed']),
      language: languages[country.code] || 'en',
      looking_for: ['dating', 'friendship', 'casual', 'long_term', 'networking']
        .sort(() => Math.random() - 0.5)
        .slice(0, randInt(1, 3))
        .join(', '),
      is_profile_complete: true,
      latitude: lat,
      longitude: lng,
    }, token);

    // 3. Upload 3 images
    const images = [
      `https://i.pravatar.cc/400?img=${avatarId}`,
      `https://i.pravatar.cc/400?img=${avatarId + 10}`,
      `https://i.pravatar.cc/400?img=${avatarId + 20}`,
    ];
    for (const url of images) {
      await api('POST', '/profile/images', { url }, token);
    }

    count++;
    if (count % 10 === 0) {
      console.log(`[${count}/100] Created ${name} (${country.code}) — ${email}`);
    }
  }

  console.log(`\nDone! ${count} users created, ${failed} failed.`);
  console.log('Login with any email above and password: Test1234@');
}

main().catch(console.error);
