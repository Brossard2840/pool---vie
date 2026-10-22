// Notifications : fil dans l'application (cloche, alertes) et notifications « push » sur le téléphone,
// même quand l'application est fermée (Web Push ; sur iPhone, l'application doit être sur l'écran d'accueil).
const webpush = require('web-push');

// Catégories que chaque pooler peut activer ou non pour son téléphone.
const KINDS = {
  trade: '🚨 Transactions', offer: '📨 Offres reçues et réponses', waiver: '⏳ Ballottage',
  freeagent: '🆕 Agents libres', draft: '🎲 Repêchage', protection: '🛡️ Listes de protection',
  highlight: '🔥 Exploits de nos joueurs', injury: '❌ Blessures de mes joueurs', standings: '👑 Changement de meneur',
  reminder: '⏰ Rappels (dates limites, fin de ballottage)', alert: '⚠️ Alertes sur mon alignement',
  block: '📣 Marché des transactions (joueurs offerts, intérêt pour les miens)', summary: '🗞️ Récap d\'hier soir (7 h)', wall: '💬 Messages sur le mur de la gang', nhl: '🔁 Joueurs qui changent d\'équipe dans la LNH', admin: '🔑 Commissaire'
};

function createNotify(app, { pool, h, getConfig, setConfig }) {
  let vapid = null;

  async function initTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications(
        id SERIAL PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        kind TEXT NOT NULL,
        audience TEXT NOT NULL DEFAULT 'all',
        title TEXT NOT NULL, body TEXT, link TEXT,
        dedupe TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS notifications_at ON notifications(at);
      CREATE TABLE IF NOT EXISTS notification_reads(
        team_id INT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
        admin_seen INT NOT NULL DEFAULT 0, team_seen INT NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions(
        endpoint TEXT PRIMARY KEY,
        team_id INT REFERENCES teams(id) ON DELETE CASCADE,
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        subscription JSONB NOT NULL,
        kinds TEXT[] NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // « known » : catégories qui existaient quand le téléphone s'est abonné. Une catégorie ajoutée plus tard
    // est donc activée d'office (la personne ne pouvait pas la refuser).
    await pool.query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS known TEXT[]`);
    await pool.query(`UPDATE push_subscriptions SET kinds = ARRAY(SELECT DISTINCT unnest(kinds || ARRAY['wall','block','summary','injury'])),
      known = $1 WHERE known IS NULL`, [Object.keys(KINDS)]);
    // Le compte commissaire n'a plus d'équipe.
    await pool.query(`UPDATE push_subscriptions SET team_id=NULL WHERE is_admin AND team_id IS NOT NULL`);
    let keys = JSON.parse((await getConfig('vapid_keys')) || 'null');
    if (!keys) { keys = webpush.generateVAPIDKeys(); await setConfig('vapid_keys', JSON.stringify(keys)); }
    vapid = keys;
  }

  // Qui voit une notification : tout le monde ('all'), une équipe ('team:ID') ou le commissaire ('admin').
  function visibleSql(me) {
    return { sql: `(audience='all' OR audience=$1 OR ($2 AND audience='admin'))`, params: [`team:${me.teamId}`, !!me.isAdmin] };
  }

  async function sendPush(n) {
    if (!vapid) return;
    const site = (await getConfig('site_url')) || 'https://example.com';
    webpush.setVapidDetails(site, vapid.publicKey, vapid.privateKey);
    const teamId = n.audience.startsWith('team:') ? Number(n.audience.slice(5)) : null;
    const { rows } = await pool.query(`
      SELECT endpoint, subscription FROM push_subscriptions
      WHERE ($1 = ANY(kinds) OR NOT ($1 = ANY(COALESCE(known, '{}')))) AND ($4::int IS NULL OR team_id IS DISTINCT FROM $4) AND ($2::text = 'all' OR ($3::int IS NOT NULL AND team_id = $3 AND NOT is_admin) OR ($2::text = 'admin' AND is_admin))`,
      [n.kind, n.audience, teamId, n.exclude || null]);
    const payload = JSON.stringify({ title: n.title, body: n.body || '', url: n.link || '/', kind: n.kind, tag: `pav-${n.id}` });
    await Promise.all(rows.map(async r => {
      try { await webpush.sendNotification(r.subscription, payload, { TTL: 6 * 3600, urgency: n.kind === 'trade' ? 'high' : 'normal' }); }
      catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) await pool.query(`DELETE FROM push_subscriptions WHERE endpoint=$1`, [r.endpoint]);
        else console.warn('Push :', e.statusCode || '', e.message);
      }
    }));
  }

  // Crée une notification (une seule fois par « dedupe ») et l'envoie aux téléphones abonnés.
  // exclude : équipe qui ne reçoit pas le « push » (l'auteur d'un message sur le mur, par exemple).
  async function notify({ kind, title, body = null, link = null, audience = 'all', dedupe = null, exclude = null }) {
    try {
      const { rows } = await pool.query(`
        INSERT INTO notifications(kind, audience, title, body, link, dedupe) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT (dedupe) DO NOTHING RETURNING *`, [kind, audience, title, body, link, dedupe]);
      if (rows[0]) sendPush({ ...rows[0], exclude }).catch(e => console.warn('Push :', e.message));
      return rows[0] || null;
    } catch (e) { console.warn('Notification :', e.message); return null; }
  }

  async function seenMarker(me) {
    if (!me.teamId) return Number(await getConfig('admin_seen')) || 0;  // compte commissaire (neutre)
    const { rows } = await pool.query(`SELECT admin_seen, team_seen FROM notification_reads WHERE team_id=$1`, [me.teamId]);
    return rows[0] ? (me.isAdmin ? rows[0].admin_seen : rows[0].team_seen) : 0;
  }

  async function unread(me) {
    const v = visibleSql(me);
    const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM notifications WHERE ${v.sql} AND id > $3 AND at > NOW() - INTERVAL '30 days'`,
      [...v.params, await seenMarker(me)]);
    return rows[0].n;
  }

  app.get('/api/notifications', h(async (req, res) => {
    const v = visibleSql(req.me);
    const after = Number(req.query.after) || 0;
    const { rows } = await pool.query(`
      SELECT id, at, kind, title, body, link FROM notifications
      WHERE ${v.sql} AND id > $3 ORDER BY id DESC LIMIT 100`, [...v.params, after]);
    res.json({ notifications: rows, seen: await seenMarker(req.me), kinds: KINDS, publicKey: vapid?.publicKey || null });
  }));

  app.post('/api/notifications/seen', h(async (req, res) => {
    const id = Number(req.body.id) || 0;
    if (!req.me.teamId) {
      await setConfig('admin_seen', Math.max(id, Number(await getConfig('admin_seen')) || 0));
      return res.json({ ok: true });
    }
    const col = req.me.isAdmin ? 'admin_seen' : 'team_seen';
    await pool.query(`INSERT INTO notification_reads(team_id, ${col}) VALUES($1,$2)
      ON CONFLICT (team_id) DO UPDATE SET ${col}=GREATEST(notification_reads.${col}, $2)`, [req.me.teamId, id]);
    res.json({ ok: true });
  }));

  app.post('/api/push/subscribe', h(async (req, res) => {
    const { subscription, kinds } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Abonnement invalide' });
    const list = (kinds || Object.keys(KINDS)).filter(k => KINDS[k]);
    // L'adresse du site sert d'identifiant auprès des services de notification (Apple, Google).
    if (!(await getConfig('site_url'))) await setConfig('site_url', `https://${req.get('host')}`);
    await pool.query(`
      INSERT INTO push_subscriptions(endpoint, team_id, is_admin, subscription, kinds, known) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT (endpoint) DO UPDATE SET team_id=EXCLUDED.team_id, is_admin=EXCLUDED.is_admin, subscription=EXCLUDED.subscription,
        kinds=EXCLUDED.kinds, known=EXCLUDED.known`,
      [subscription.endpoint, req.me.teamId, !!req.me.isAdmin, subscription, list, Object.keys(KINDS)]);
    res.json({ ok: true, kinds: list });
  }));

  app.post('/api/push/status', h(async (req, res) => {
    const { rows } = await pool.query(`SELECT kinds, known FROM push_subscriptions WHERE endpoint=$1`, [req.body.endpoint || '']);
    const r = rows[0];
    res.json({ subscribed: !!r, kinds: r ? Object.keys(KINDS).filter(k => r.kinds.includes(k) || !(r.known || []).includes(k)) : [] });
  }));

  app.post('/api/push/unsubscribe', h(async (req, res) => {
    await pool.query(`DELETE FROM push_subscriptions WHERE endpoint=$1`, [req.body.endpoint || '']);
    res.json({ ok: true });
  }));

  app.post('/api/push/test', h(async (req, res) => {
    const n = await notify({ kind: 'offer', audience: req.me.teamId ? `team:${req.me.teamId}` : 'admin', title: '🔔 Test de notification',
      body: 'Si tu lis ceci sur ton téléphone, les notifications fonctionnent !', link: '#/notifications' });
    // Le test va aussi au téléphone du commissaire qui le demande.
    if (req.me.isAdmin && n) {
      const { rows } = await pool.query(`SELECT endpoint, subscription FROM push_subscriptions WHERE endpoint=$1`, [req.body.endpoint || '']);
      if (rows[0]) await webpush.sendNotification(rows[0].subscription, JSON.stringify({ title: n.title, body: n.body, url: n.link })).catch(() => {});
    }
    res.json({ ok: true });
  }));

  return { initTables, notify, unread, KINDS };
}

module.exports = { createNotify, KINDS };
