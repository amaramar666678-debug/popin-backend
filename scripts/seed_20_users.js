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
        try {
          resolve({ status: res.statusCode, data: JSON.parse(chunks) });
        } catch {
          resolve({ status: res.statusCode, data: chunks });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const users = [
  // ── United States ──
  { email: 'emma@test.com', name: 'Emma Wilson', gender: 'female', country_code: 'US', dob: '1995-04-12', bio: 'Photographer & brunch enthusiast. Exploring life one frame at a time.', lat: 40.7128, lng: -74.006 },
  { email: 'james@test.com', name: 'James Miller', gender: 'male', country_code: 'US', dob: '1993-09-05', bio: 'Software engineer by day, rock climber by weekend. Always up for an adventure.', lat: 37.7749, lng: -122.4194 },
  { email: 'sophia@test.com', name: 'Sophia Garcia', gender: 'female', country_code: 'US', dob: '1997-01-18', bio: 'Plant mom, yoga lover, and amateur chef. Looking for my plus one.', lat: 34.0522, lng: -118.2437 },

  // ── United Kingdom ──
  { email: 'oliver@test.com', name: 'Oliver Taylor', gender: 'male', country_code: 'GB', dob: '1992-06-20', bio: 'Football fan, craft beer lover, terrible dancer but full of enthusiasm.', lat: 51.5074, lng: -0.1278 },
  { email: 'mia@test.com', name: 'Mia Brown', gender: 'female', country_code: 'GB', dob: '1996-11-03', bio: 'Art historian, tea addict, and weekend painter. Let me bore you with art facts.', lat: 53.4808, lng: -2.2426 },
  { email: 'liam@test.com', name: 'Liam Davies', gender: 'male', country_code: 'GB', dob: '1994-03-28', bio: 'Chef who loves the outdoors. If you like food and hiking, we will get along.', lat: 55.9533, lng: -3.1883 },

  // ── France ──
  { email: 'chloe@test.com', name: 'Chloe Laurent', gender: 'female', country_code: 'FR', dob: '1998-07-14', bio: 'Parisian with a love for travel, fashion, and croissants. Oui oui.', lat: 48.8566, lng: 2.3522 },
  { email: 'lucas@test.com', name: 'Lucas Moreau', gender: 'male', country_code: 'FR', dob: '1991-12-01', bio: 'Musician, wine lover, and hopeless romantic. Searching for my muse.', lat: 43.2965, lng: 5.3698 },

  // ── Germany ──
  { email: 'hanna@test.com', name: 'Hanna Schmidt', gender: 'female', country_code: 'DE', dob: '1995-08-22', bio: 'Engineer by trade, artist at heart. Love museums, cycling, and good conversation.', lat: 52.52, lng: 13.405 },
  { email: 'felix@test.com', name: 'Felix Weber', gender: 'male', country_code: 'DE', dob: '1993-02-14', bio: 'Board game nerd, runner, and coffee snob. Looking for my player 2.', lat: 50.1109, lng: 8.6821 },

  // ── Australia ──
  { email: 'isla@test.com', name: 'Isla Cooper', gender: 'female', country_code: 'AU', dob: '1996-10-09', bio: 'Surfer, marine biologist, and dog lover. Life is better at the beach.', lat: -33.8688, lng: 151.2093 },
  { email: 'noah@test.com', name: 'Noah Bennett', gender: 'male', country_code: 'AU', dob: '1994-05-17', bio: 'Outdoor guide who can cook. If you can keep up on a hike, I am yours.', lat: -37.8136, lng: 144.9631 },
  { email: 'amelia@test.com', name: 'Amelia Foster', gender: 'female', country_code: 'AU', dob: '1997-12-25', bio: 'Nurse by profession, traveler by passion. Making the world a better place.', lat: -27.4698, lng: 153.0251 },

  // ── Canada ──
  { email: 'ethan@test.com', name: 'Ethan Clarke', gender: 'male', country_code: 'CA', dob: '1992-04-30', bio: 'Hockey player, maple syrup connoisseur, and proud Canadian. Sorry for apologizing.', lat: 43.6532, lng: -79.3832 },
  { email: 'ava@test.com', name: 'Ava White', gender: 'female', country_code: 'CA', dob: '1995-09-11', bio: 'Writer, forest bather, and cat mom. Looking for someone to read with.', lat: 49.2827, lng: -123.1207 },

  // ── UAE / Middle East ──
  { email: 'zayn@test.com', name: 'Zayn Khalid', gender: 'male', country_code: 'AE', dob: '1993-11-07', bio: 'Architect building dreams. Love desert safaris, shisha, and good food.', lat: 25.2048, lng: 55.2708 },
  { email: 'layla@test.com', name: 'Layla Hassan', gender: 'female', country_code: 'AE', dob: '1996-06-15', bio: 'Fashion designer, coffee addict, and sunset chaser. Dubai girl through and through.', lat: 25.2048, lng: 55.2708 },

  // ── Brazil ──
  { email: 'lorenzo@test.com', name: 'Lorenzo Silva', gender: 'male', country_code: 'BR', dob: '1991-08-19', bio: 'Samba dancer, football fanatic, and caipirinha maker. Lets have fun!', lat: -23.5505, lng: -46.6333 },

  // ── Japan ──
  { email: 'yuki@test.com', name: 'Yuki Tanaka', gender: 'female', country_code: 'JP', dob: '1998-03-03', bio: 'Anime enthusiast, ramen lover, and karaoke champion. Can you handle my singing?', lat: 35.6762, lng: 139.6503 },

  // ── Italy ──
  { email: 'marco@test.com', name: 'Marco Rossi', gender: 'male', country_code: 'IT', dob: '1992-12-10', bio: 'Pizza maker, Vespa rider, and mama\'s boy. Looking for my Italian dream.', lat: 41.9028, lng: 12.4964 },
];

const imageIds = [1015, 1016, 1020, 1024, 1025, 1035, 1040, 1044, 1049, 1050, 1055, 1060, 1062, 1067, 1070, 1074, 1077, 1080, 1084, 1090];

async function main() {
  let count = 0;
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const imgId = imageIds[i % imageIds.length];

    const reg = await api('POST', '/auth/register', {
      email: u.email,
      password: 'Test1234@',
      username: u.name.toLowerCase().replace(/\s+/g, '_'),
      full_name: u.name,
      gender: u.gender,
      country_code: u.country_code,
      date_of_birth: u.dob,
    });

    if (reg.status === 409) {
      console.log(`Skipping ${u.name} — already exists`);
      continue;
    }
    if (reg.status !== 201) {
      console.log(`Failed ${u.name}:`, reg.data?.error || reg.data);
      continue;
    }

    const token = reg.data.access_token;
    const userId = reg.data.user?.id;

    // Complete profile
    await api('PUT', '/profile', {
      bio: u.bio,
      education_level: ['high_school', 'bachelor', 'master', 'phd'][Math.floor(Math.random() * 4)],
      work_status: ['student', 'employed', 'self_employed', 'unemployed'][Math.floor(Math.random() * 4)],
      is_smoker: Math.random() > 0.7 ? 'yes' : 'no',
      drinks_alcohol: ['never', 'sometimes', 'often', 'socially'][Math.floor(Math.random() * 4)],
      children_count: Math.random() > 0.8 ? 1 : 0,
      language: u.country_code === 'FR' ? 'fr' : u.country_code === 'DE' ? 'de' : u.country_code === 'JP' ? 'ja' : u.country_code === 'BR' ? 'pt' : u.country_code === 'IT' ? 'it' : u.country_code === 'AE' ? 'ar' : 'en',
      looking_for: ['dating', 'friendship', 'casual', 'long_term', 'networking'].slice(0, Math.floor(Math.random() * 3) + 1).join(', '),
      is_profile_complete: true,
      latitude: u.lat,
      longitude: u.lng,
    }, token);

    // Upload images (3 per user)
    const baseImages = [
      `https://images.unsplash.com/photo-${imgId}?w=400&h=600&fit=crop`,
      `https://images.unsplash.com/photo-${imgId + 1}?w=400&h=600&fit=crop`,
      `https://images.unsplash.com/photo-${imgId + 2}?w=400&h=600&fit=crop`,
    ];
    for (let j = 0; j < baseImages.length; j++) {
      await api('POST', '/profile/images', { url: baseImages[j] }, token);
    }

    count++;
    console.log(`[${count}/20] Created ${u.name} (${u.country_code}) — ${u.email} / Test1234@`);
  }

  console.log(`\nDone! ${count} users created.`);
  console.log('Login with any email above and password: Test1234@');
}

main().catch(console.error);
