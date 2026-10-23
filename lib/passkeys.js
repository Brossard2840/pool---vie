// Connexion par reconnaissance faciale (Face ID, empreinte, NIP du téléphone) : clés d'accès WebAuthn (« passkeys »).
// Le pooler entre une première fois avec son code, puis active Face ID sur son appareil. La clé privée reste
// dans le téléphone ; le serveur garde seulement la clé publique. Un nouveau code d'équipe (ou de commissaire)
// rend les clés d'accès existantes inutilisables : il faut se reconnecter avec le code et réactiver Face ID.
const crypto = require('crypto');
const { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');

const CHALLENGE_MS = 5 * 60 * 1000;

function err(message, status = 400) { return Object.assign(new Error(message), { status }); }

function createPasskeys(app, { pool, h, auth, getConfig, secret, secure }) {
  // Défis en attente (une seule instance du serveur) : jeton → { challenge, at, me }.
  const pending = new Map();
  function remember(data) {
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.at > CHALLENGE_MS) pending.delete(k);
    const token = crypto.randomBytes(16).toString('hex');
    pending.set(token, { ...data, at: now });
    return token;
  }
  function take(token) {
    const v = pending.get(String(token || ''));
    pending.delete(String(token || ''));
    if (!v || Date.now() - v.at > CHALLENGE_MS) throw err('Délai expiré, réessaie.');
    return v;
  }
  // Le domaine et l'adresse du site, tels que vus par le téléphone (Render passe par un mandataire).
  const rp = req => ({ rpID: req.hostname, origin: `${req.protocol}://${req.get('host')}` });

  async function initTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS passkeys(
        id TEXT PRIMARY KEY,
        team_id INT REFERENCES teams(id) ON DELETE CASCADE,
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        public_key BYTEA NOT NULL,
        counter BIGINT NOT NULL DEFAULT 0,
        transports TEXT[],
        code_version INT,
        label TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        used_at TIMESTAMPTZ
      );
    `);
  }

  // Version du code au moment présent : une clé créée avec un ancien code ne fonctionne plus.
  async function currentVersion(teamId, isAdmin) {
    if (isAdmin) return Number(await getConfig('commissaire_version')) || 0;
    const { rows } = await pool.query(`SELECT code_version FROM teams WHERE id=$1 AND code_hash IS NOT NULL`, [teamId]);
    return rows[0] ? Number(rows[0].code_version) || 0 : null;
  }
  const owner = me => me.teamId ? { teamId: me.teamId, isAdmin: false } : { teamId: null, isAdmin: true };

  // --- Activer Face ID (connecté avec le code) ---
  app.post('/api/passkey/register/options', h(async (req, res) => {
    if (!req.me) throw err('Connexion requise', 401);
    const o = owner(req.me);
    const { rows } = await pool.query(`SELECT id, transports FROM passkeys WHERE ${o.isAdmin ? 'is_admin' : 'team_id=$1'}`, o.isAdmin ? [] : [o.teamId]);
    const name = o.isAdmin ? 'Commissaire' : req.me.name;
    const options = await generateRegistrationOptions({
      rpName: 'Pool à vie', rpID: rp(req).rpID,
      userName: name, userDisplayName: `${name} · Pool à vie`,
      userID: new TextEncoder().encode(o.isAdmin ? 'admin' : `team:${o.teamId}`),
      attestationType: 'none',
      excludeCredentials: rows.map(r => ({ id: r.id, transports: r.transports || undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
    });
    res.json({ token: remember({ challenge: options.challenge, owner: o }), options });
  }));

  app.post('/api/passkey/register/verify', h(async (req, res) => {
    if (!req.me) throw err('Connexion requise', 401);
    const p = take(req.body.token), o = owner(req.me);
    if (p.owner.teamId !== o.teamId || p.owner.isAdmin !== o.isAdmin) throw err('Session changée, réessaie.');
    const { rpID, origin } = rp(req);
    let v;
    try { v = await verifyRegistrationResponse({ response: req.body.response, expectedChallenge: p.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true }); }
    catch (e) { throw err('Activation refusée : ' + e.message); }
    if (!v.verified || !v.registrationInfo) throw err('Activation refusée');
    const c = v.registrationInfo.credential;
    const label = String(req.body.label || '').trim().slice(0, 60) || null;
    await pool.query(`
      INSERT INTO passkeys(id, team_id, is_admin, public_key, counter, transports, code_version, label) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO UPDATE SET team_id=EXCLUDED.team_id, is_admin=EXCLUDED.is_admin, public_key=EXCLUDED.public_key,
        counter=EXCLUDED.counter, code_version=EXCLUDED.code_version, label=EXCLUDED.label`,
      [c.id, o.teamId, o.isAdmin, Buffer.from(c.publicKey), c.counter || 0, c.transports || null, await currentVersion(o.teamId, o.isAdmin), label]);
    res.json({ ok: true, id: c.id });
  }));

  // --- Se connecter avec Face ID (sans code) ---
  app.post('/api/passkey/login/options', h(async (req, res) => {
    const options = await generateAuthenticationOptions({ rpID: rp(req).rpID, userVerification: 'required', allowCredentials: [] });
    res.json({ token: remember({ challenge: options.challenge }), options });
  }));

  app.post('/api/passkey/login/verify', h(async (req, res) => {
    const p = take(req.body.token), response = req.body.response || {};
    const { rows } = await pool.query(`SELECT * FROM passkeys WHERE id=$1`, [String(response.id || '')]);
    const k = rows[0];
    if (!k) throw err('Cette clé d\'accès n\'est plus reconnue. Entre ton code, puis réactive Face ID.', 401);
    const version = await currentVersion(k.team_id, k.is_admin);
    if (version === null || Number(k.code_version) !== version) {
      await pool.query(`DELETE FROM passkeys WHERE id=$1`, [k.id]);
      throw err('Ton code a changé depuis l\'activation de Face ID. Entre le nouveau code, puis réactive Face ID.', 401);
    }
    const { rpID, origin } = rp(req);
    let v;
    try {
      v = await verifyAuthenticationResponse({ response, expectedChallenge: p.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: k.id, publicKey: new Uint8Array(k.public_key), counter: Number(k.counter), transports: k.transports || undefined } });
    } catch (e) { throw err('Connexion refusée : ' + e.message, 401); }
    if (!v.verified) throw err('Connexion refusée', 401);
    await pool.query(`UPDATE passkeys SET counter=$2, used_at=NOW() WHERE id=$1`, [k.id, v.authenticationInfo.newCounter]);
    if (k.is_admin) auth.setSession(res, { admin: true, av: await getConfig('commissaire_version') }, secret(), secure);
    else auth.setSession(res, { teamId: k.team_id, v: version }, secret(), secure);
    res.json({ ok: true });
  }));

  // --- Mes appareils avec Face ID (réglages) ---
  app.get('/api/passkey', h(async (req, res) => {
    if (!req.me) throw err('Connexion requise', 401);
    const o = owner(req.me);
    const { rows } = await pool.query(`SELECT id, label, created_at, used_at FROM passkeys WHERE ${o.isAdmin ? 'is_admin' : 'team_id=$1'} ORDER BY created_at`, o.isAdmin ? [] : [o.teamId]);
    res.json(rows);
  }));

  app.delete('/api/passkey/:id', h(async (req, res) => {
    if (!req.me) throw err('Connexion requise', 401);
    const o = owner(req.me);
    await pool.query(`DELETE FROM passkeys WHERE id=$1 AND ${o.isAdmin ? 'is_admin' : 'team_id=$2'}`, o.isAdmin ? [req.params.id] : [req.params.id, o.teamId]);
    res.json({ ok: true });
  }));

  return { initTables };
}

module.exports = { createPasskeys };
