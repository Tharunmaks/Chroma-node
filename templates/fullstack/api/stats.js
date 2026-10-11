// GET /api/fn/<project>/stats — a JavaScript server function.
// Runs in a sandbox with access to this project's database only.
// (Server admins can disable JS functions with ALLOW_JS_FUNCTIONS=0.)
export default async function (req, { db }) {
  const { total } = await db.collection('guestbook').list({ limit: 1 });
  return { json: { total }, headers: { 'Cache-Control': 'no-store' } };
}
