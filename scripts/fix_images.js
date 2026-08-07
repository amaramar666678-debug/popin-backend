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
  { email: 'emma@test.com', seed: 'emma' },
  { email: 'james@test.com', seed: 'james' },
  { email: 'sophia@test.com', seed: 'sophia' },
  { email: 'oliver@test.com', seed: 'oliver' },
  { email: 'mia@test.com', seed: 'mia' },
  { email: 'liam@test.com', seed: 'liam' },
  { email: 'chloe@test.com', seed: 'chloe' },
  { email: 'lucas@test.com', seed: 'lucas' },
  { email: 'hanna@test.com', seed: 'hanna' },
  { email: 'felix@test.com', seed: 'felix' },
  { email: 'isla@test.com', seed: 'isla' },
  { email: 'noah@test.com', seed: 'noah' },
  { email: 'amelia@test.com', seed: 'amelia' },
  { email: 'ethan@test.com', seed: 'ethan' },
  { email: 'ava@test.com', seed: 'ava' },
  { email: 'zayn@test.com', seed: 'zayn' },
  { email: 'layla@test.com', seed: 'layla' },
  { email: 'lorenzo@test.com', seed: 'lorenzo' },
  { email: 'yuki@test.com', seed: 'yuki' },
  { email: 'marco@test.com', seed: 'marco' },
];

async function main() {
  for (const u of users) {
    const login = await api('POST', '/auth/login', {
      email: u.email,
      password: 'Test1234@',
    });
    if (login.status !== 200) {
      console.log(`Cannot login ${u.email}:`, login.data?.error);
      continue;
    }
    const token = login.data.access_token;

    // Get existing images and delete them
    const imgRes = await api('GET', '/profile/images', null, token);
    if (imgRes.status === 200 && Array.isArray(imgRes.data?.images)) {
      for (const img of imgRes.data.images) {
        await api('DELETE', `/profile/images/${img.id}`, null, token);
      }
    }

    // Upload 3 new picsum images
    for (let j = 0; j < 3; j++) {
      const url = `https://picsum.photos/seed/${u.seed}${j}/400/600`;
      await api('POST', '/profile/images', { url }, token);
    }

    console.log(`Fixed images for ${u.email}`);
  }

  console.log('\nDone! All images fixed with picsum.photos URLs.');
}

main().catch(console.error);
