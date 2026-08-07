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
  {
    email: 'alice@test.com', name: 'Alice', full_name: 'Alice Johnson',
    password: 'Test1234@', gender: 'female', country_code: 'US',
    date_of_birth: '1996-03-15',
    bio: 'Love hiking and good coffee. Looking for meaningful connections.',
  },
  {
    email: 'bob@test.com', name: 'Bob', full_name: 'Bob Smith',
    password: 'Test1234@', gender: 'male', country_code: 'US',
    date_of_birth: '1994-07-22',
    bio: 'Dog dad, casual gamer, enjoy good food & good vibes.',
  },
  {
    email: 'charlie@test.com', name: 'Charlie', full_name: 'Charlie Brown',
    password: 'Test1234@', gender: 'male', country_code: 'GB',
    date_of_birth: '1997-11-08',
    bio: 'Musician and artist. Always exploring new sounds and colors.',
  },
  {
    email: 'diana@test.com', name: 'Diana', full_name: 'Diana Prince',
    password: 'Test1234@', gender: 'female', country_code: 'AU',
    date_of_birth: '1995-05-30',
    bio: 'Yoga instructor & bookworm. Looking for someone to share sunsets with.',
  },
];

async function main() {
  const created = [];
  for (const u of users) {
    const reg = await api('POST', '/auth/register', {
      email: u.email,
      password: u.password,
      username: u.name,
      full_name: u.full_name,
      gender: u.gender,
      country_code: u.country_code,
      date_of_birth: u.date_of_birth,
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

    // Complete profile
    await api('PUT', '/profile', {
      bio: u.bio,
      education: 'university',
      work_status: 'employed',
      smoker: 'no',
      drinks_alcohol: 'sometimes',
      children: 'no',
      language: 'en',
      looking_for: 'dating, friendship',
      is_profile_complete: true,
      latitude: u.country_code === 'AU' ? -33.8688 : u.country_code === 'GB' ? 51.5074 : 40.7128,
      longitude: u.country_code === 'AU' ? 151.2093 : u.country_code === 'GB' ? -0.1278 : -74.006,
    }, token);

    created.push({ name: u.name, email: u.email });
    console.log(`Created ${u.name} (${u.email})`);
  }

  console.log('\nLogin:  email / Test1234@');
}

main().catch(console.error);
