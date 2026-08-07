require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  try {
    const users = await pool.query("SELECT u.id, u.email, u.name, i.\"imageUrl\" FROM public.\"User\" u LEFT JOIN public.\"Image\" i ON i.\"userId\" = u.id WHERE u.email IN ('alice@test.com','bob@test.com','charlie@test.com','diana@test.com')");
    console.log(JSON.stringify(users.rows, null, 2));
  } catch (e) { console.error(e.message); }
  finally { await pool.end(); }
})();
