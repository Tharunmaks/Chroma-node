# Realtime 3D guestbook

1. Deploy: `chroma deploy` (or *New project → Full-stack 3D app* in the dashboard).
2. In the dashboard, open the project → **Database** and create the collection `guestbook`
   with read **Anyone (public read)** and write **Anyone can add**.
3. Open the site: messages appear for every visitor instantly; **Analytics** shows views and
   `guestbook.signed` events live.

`api/stats.js` is a JavaScript server function (servers can disable these with `ALLOW_JS_FUNCTIONS=0`).
