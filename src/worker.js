const OWNER = 'gold';
const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
const E = (m, s = 400) => J({ error: m }, s);
const cl = s => String(s || '').replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
const rnd = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const API = 'https://unixgram.com'; // Bot API Unixgram (формат как у Telegram): /api/bot/{token}/{method}
const SPEED = 0.00012; // рост множителя Rockets: exp(SPEED * мс)
// Таблицы создаются сами при первом запросе: заходить в консоль Cloudflare не нужно
const DDL = [
  "CREATE TABLE IF NOT EXISTS users(name TEXT PRIMARY KEY, bal INTEGER NOT NULL DEFAULT 0 CHECK(bal>=0), opens INTEGER NOT NULL DEFAULT 0, donated INTEGER NOT NULL DEFAULT 0, avatar TEXT NOT NULL DEFAULT '', banned INTEGER NOT NULL DEFAULT 0, ban_reason TEXT NOT NULL DEFAULT '');",
  "CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user TEXT NOT NULL, adm INTEGER NOT NULL DEFAULT 0, created INTEGER);",
  "CREATE TABLE IF NOT EXISTS cases(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price INTEGER NOT NULL, img TEXT NOT NULL DEFAULT '');",
  "CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL, w REAL NOT NULL, img TEXT NOT NULL DEFAULT '');",
  "CREATE TABLE IF NOT EXISTS inv(id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL, img TEXT NOT NULL DEFAULT '');",
  "CREATE TABLE IF NOT EXISTS wheel(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, value INTEGER NOT NULL, w REAL NOT NULL, img TEXT NOT NULL DEFAULT '');",
  "CREATE TABLE IF NOT EXISTS wspin(user TEXT PRIMARY KEY, at INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS imgs(id TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS badges(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '', img TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#2f8cff');",
  "CREATE TABLE IF NOT EXISTS ubadges(user TEXT NOT NULL, badge INTEGER NOT NULL, PRIMARY KEY(user, badge));",
  "CREATE INDEX IF NOT EXISTS ubadges_badge ON ubadges(badge);",
  "CREATE TABLE IF NOT EXISTS alog(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL, target TEXT NOT NULL, act TEXT NOT NULL, info TEXT NOT NULL DEFAULT '');",
  "CREATE INDEX IF NOT EXISTS alog_target ON alog(target);",
  "CREATE INDEX IF NOT EXISTS inv_user ON inv(user);",
  "CREATE TABLE IF NOT EXISTS reqs(id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, type TEXT NOT NULL, amount INTEGER DEFAULT 0, from_user TEXT, item_name TEXT, item_value INTEGER, status TEXT NOT NULL DEFAULT 'new', created INTEGER);",
  "CREATE INDEX IF NOT EXISTS reqs_user ON reqs(user);",
  "CREATE TABLE IF NOT EXISTS admins(name TEXT PRIMARY KEY);",
  "CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS rockets(id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, bet INTEGER NOT NULL, crash REAL NOT NULL, t0 INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active');",
  "CREATE INDEX IF NOT EXISTS rockets_user ON rockets(user,status);",
  "CREATE TABLE IF NOT EXISTS codes(username TEXT PRIMARY KEY, hash TEXT NOT NULL, exp INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS tg_users(username TEXT PRIMARY KEY, chat_id INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS deposits(id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new', charge TEXT, created INTEGER);",
  "CREATE TABLE IF NOT EXISTS mines(id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, bet INTEGER NOT NULL, size INTEGER NOT NULL, mc INTEGER NOT NULL, pos TEXT NOT NULL, opened TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created INTEGER);",
  "CREATE UNIQUE INDEX IF NOT EXISTS mines_active ON mines(user) WHERE status='active';",
  "CREATE TABLE IF NOT EXISTS accounts(name TEXT PRIMARY KEY, pw TEXT NOT NULL, fails INTEGER NOT NULL DEFAULT 0, lock INTEGER NOT NULL DEFAULT 0);",
  "CREATE TABLE IF NOT EXISTS vreq(username TEXT PRIMARY KEY, code TEXT NOT NULL, exp INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0);"
];
let ready = false;
// Колонки img для баз, созданных до появления фото (на новой базе ALTER просто не сработает)
const ALTERS = [
  "ALTER TABLE cases ADD COLUMN img TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE items ADD COLUMN img TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE inv ADD COLUMN img TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN opens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN donated INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN ban_reason TEXT NOT NULL DEFAULT ''"
];
async function ensure(DB) {
  if (ready) return;
  await DB.batch(DDL.map(q => DB.prepare(q)));
  for (const q of ALTERS) { try { await DB.prepare(q).run(); } catch {} }
  ready = true;
}
// Фото: id хранится в строке, сам файл лежит в таблице imgs и отдаётся по /api/img/<id>
const IMG_RE = /^[a-f0-9-]{36}$/;
const im = s => (IMG_RE.test(String(s || '')) ? String(s) : '');
// Удаляем фото, на которые больше никто не ссылается (кроме загруженных в последний час: их ещё сохраняют)
const gcImgs = DB => DB.prepare("DELETE FROM imgs WHERE ts<?1 AND id NOT IN (SELECT img FROM cases UNION SELECT img FROM items UNION SELECT img FROM wheel UNION SELECT img FROM inv UNION SELECT img FROM badges UNION SELECT avatar FROM users)").bind(Date.now() - 3600000).run();

// Сохраняет картинку из data:-URL в таблицу imgs, возвращает id или null, если файл не подходит
async function putImg(DB, data, max) {
  const m = /^data:(image\/(?:webp|png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(data || ''));
  if (!m || m[2].length > max) return null;
  const head = atob(m[2].slice(0, 24)); // проверка «магических» байтов: файл должен действительно быть картинкой
  const okType = m[1] === 'image/png' ? head.startsWith('\x89PNG') : m[1] === 'image/jpeg' ? head.startsWith('\xff\xd8\xff') : (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP');
  if (!okType) return null;
  const id = crypto.randomUUID();
  await DB.prepare('INSERT INTO imgs(id,mime,data,ts) VALUES(?,?,?,?)').bind(id, m[1], m[2], Date.now()).run();
  return id;
}
// Добавляет игрокам из списка их бейджи
async function withBadges(DB, rows) {
  const bm = {};
  if (rows.length) {
    const ph = rows.map((_, i) => '?' + (i + 1)).join(',');
    const bs = (await DB.prepare(`SELECT ub.user u,b.id,b.name,b.icon,b.img,b.color FROM ubadges ub JOIN badges b ON b.id=ub.badge WHERE ub.user IN (${ph}) ORDER BY b.id`).bind(...rows.map(r => r.name)).all()).results;
    for (const x of bs) (bm[x.u] ||= []).push({ id: x.id, name: x.name, icon: x.icon, img: x.img, color: x.color });
  }
  return rows.map(r => ({ ...r, badges: bm[r.name] || [] }));
}

// Сообщение для заблокированного игрока (null, если всё в порядке)
async function banMsg(DB, u) {
  const r = await DB.prepare('SELECT banned,ban_reason FROM users WHERE name=?').bind(u).first();
  return r && r.banned ? 'Аккаунт заблокирован' + (r.ban_reason ? ': ' + r.ban_reason : '') : null;
}
// Запись действия админа в журнал (хранится последние 2000 записей)
async function alog(DB, actor, target, act, info = '') {
  await DB.prepare('INSERT INTO alog(ts,actor,target,act,info) VALUES(?,?,?,?,?)').bind(Date.now(), actor, target, act, String(info).slice(0, 200)).run();
  await DB.prepare('DELETE FROM alog WHERE id < (SELECT MAX(id) FROM alog) - 2000').run();
}
// Можно ли админу actor менять аккаунт n. Владельца и других админов трогает только владелец;
// опасные действия (бан, удаление, сброс пароля) с владельцем запрещены всем.
async function guardT(DB, actor, n, danger) {
  if (!n || n.length < 3) return 'Укажите юзернейм игрока';
  if (!(await DB.prepare('SELECT 1 x FROM users WHERE name=?').bind(n).first())) return 'Игрок @' + n + ' не найден: он должен хотя бы раз войти на сайт';
  if (n === OWNER && danger) return 'Аккаунт владельца защищён от этого действия';
  if (actor !== OWNER) {
    if (n === OWNER) return 'Нельзя менять аккаунт владельца';
    if (await isAdm(DB, n)) return 'Аккаунт админа может менять только владелец';
  }
  return null;
}

const ITER = 15000; // пароли игроков
const pwHash = (pw, salt) => hash(pw, salt, ITER);
async function hash(pw, salt, iter = 100000) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: iter, hash: 'SHA-256' }, k, 256));
}
async function passOk(DB, env, pw) {
  pw = String(pw || '');
  const h = await DB.prepare("SELECT v FROM settings WHERE k='pass'").first();
  if (h) { const [s, x] = h.v.split(':'); return (await hash(pw, s)) === x; }
  return !!env.ADMIN_PASSWORD && pw === env.ADMIN_PASSWORD;
}
// [мин, макс, по умолчанию] — все числовые настройки, которые меняются в админке
const SPEC = {
  dep_fee: [0, 100, 5], sell_fee: [0, 100, 5], dmin: [0, 1e9, 0], wmin: [0, 1e9, 0], code_ttl: [1, 1440, 30],
  on_cases: [0, 1, 1], on_rocket: [0, 1, 1], on_mines: [0, 1, 1], on_wheel: [0, 1, 1],
  wheel_price: [0, 1e9, 10], wheel_free: [0, 1, 1], wheel_cd: [1, 720, 24],
  rtp: [50, 100, 97], r1: [0, 90, 0], rmax: [2, 10000, 1000], rbmin: [1, 1e9, 1], rbmax: [1, 1e9, 10000],
  mn: [3, 7, 5], mmin: [1, 48, 1], mmax: [1, 48, 10], mrtp: [50, 100, 97], mbmin: [1, 1e9, 1], mbmax: [1, 1e9, 10000], mcap: [2, 100000, 1000]
};
async function cfg(DB) {
  const o = { bot: 'unixbot', recv: 'unix_stars_bank', site: 'Unix Stars' };
  for (const k in SPEC) o[k] = String(SPEC[k][2]);
  for (const x of (await DB.prepare("SELECT k,v FROM settings WHERE k NOT IN ('pass','token','offset','poll_at','ofail','olock')").all()).results) o[x.k] = x.v;
  return o;
}
// множитель Сапёра после k открытых клеток
const mm = (n, mc, k, c) => {
  if (k <= 0) return 1;
  const t = n * n; let m = 1;
  for (let i = 0; i < k; i++) m *= (t - i) / (t - mc - i);
  return Math.min(+c.mcap, Math.max(1, Math.floor(m * (+c.mrtp / 100) * 100) / 100));
};
const sha = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
async function bot(DB, env, method, params) {
  const t = (await DB.prepare("SELECT v FROM settings WHERE k='token'").first())?.v || env.BOT_TOKEN;
  if (!t) throw new Error('Бот не подключён');
  const r = await fetch(`${API}/api/bot/${t}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) throw new Error(d.description || 'Ошибка бота');
  return d.result;
}
const chatOf = async (DB, u) => (await DB.prepare('SELECT chat_id FROM tg_users WHERE username=?').bind(u).first())?.chat_id || '@' + u;
async function hook(DB, env, up) {
  const pq = up.pre_checkout_query;
  if (pq) {
    const m = /^dep:(\d+)$/.exec(pq.invoice_payload || '');
    const d = m && await DB.prepare('SELECT amount,status FROM deposits WHERE id=?').bind(+m[1]).first();
    const ok = !!d && d.status === 'new' && d.amount === pq.total_amount;
    try { await bot(DB, env, 'answerPreCheckoutQuery', { pre_checkout_query_id: pq.id, ok, ...(ok ? {} : { error_message: 'Счёт недействителен' }) }); } catch {}
    return J({ ok: 1 });
  }
  const m = up.message;
  if (!m) return J({ ok: 1 });
  const un = cl(m.from?.username);
  if (un && m.chat?.id) await DB.prepare('INSERT INTO tg_users(username,chat_id) VALUES(?1,?2) ON CONFLICT(username) DO UPDATE SET chat_id=excluded.chat_id').bind(un, m.chat.id).run();
  const sp = m.successful_payment;
  if (sp) {
    const mm = /^dep:(\d+)$/.exec(sp.invoice_payload || '');
    const d = mm && await DB.prepare('SELECT id,user,amount FROM deposits WHERE id=?').bind(+mm[1]).first();
    if (d && sp.total_amount >= d.amount) {
      const get = Math.floor(d.amount * (100 - +(await cfg(DB)).dep_fee) / 100);
      await DB.batch([
        DB.prepare("UPDATE deposits SET status='paid',charge=?1 WHERE id=?2 AND status='new'").bind(String(sp.telegram_payment_charge_id || ''), d.id),
        DB.prepare('UPDATE users SET bal=bal+?1 WHERE name=?2 AND changes()>0').bind(get, d.user),
        DB.prepare('UPDATE users SET donated=donated+?1 WHERE name=?2 AND changes()>0').bind(d.amount, d.user)
      ]);
      try { await bot(DB, env, 'sendMessage', { chat_id: m.chat.id, text: `Зачислено ${get} ⭐` }); } catch {}
    }
  } else if (String(m.text ?? m.body ?? '').startsWith('/start')) {
    try { await bot(DB, env, 'sendMessage', { chat_id: m.chat.id, text: 'Это бот сайта. Вернитесь на сайт и запросите код входа.' }); } catch {}
  }
  return J({ ok: 1 });
}
const setK = (DB, k, v) => DB.prepare('INSERT INTO settings(k,v) VALUES(?1,?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, String(v)).run();
// Получение событий опросом getUpdates: вебхук и секреты не нужны
async function pollBot(DB, env) {
  if (!(await botOn(DB, env))) return;
  const now = Date.now();
  const lk = await DB.prepare("INSERT INTO settings(k,v) VALUES('poll_at',?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v WHERE CAST(settings.v AS INTEGER) < ?2").bind(String(now), now - 2500).run();
  if (!lk.meta.changes) return;
  try {
    const off = +((await DB.prepare("SELECT v FROM settings WHERE k='offset'").first())?.v || 0);
    const ups = await bot(DB, env, 'getUpdates', { ...(off ? { offset: off } : {}), timeout: 0, limit: 100 });
    let last = 0;
    for (const up of Array.isArray(ups) ? ups : []) {
      try { await hook(DB, env, up); } catch {}
      last = Math.max(last, +up.update_id || 0);
      await setK(DB, 'last_upd', JSON.stringify(up).slice(0, 700));
    }
    if (last) await setK(DB, 'offset', last + 1);
    await setK(DB, 'bot_err', '');
  } catch (e) { await setK(DB, 'bot_err', String(e.message || e).slice(0, 200)); }
}
const botOn = async (DB, env) => !!((await DB.prepare("SELECT v FROM settings WHERE k='token'").first())?.v || env.BOT_TOKEN);
const isAdm = async (DB, u) => u === OWNER || !!(await DB.prepare('SELECT 1 x FROM admins WHERE name=?').bind(u).first());

async function issueCode(DB, env, u) {
  const old = await DB.prepare('SELECT sent FROM codes WHERE username=?').bind(u).first();
  if (old && Date.now() - old.sent < 30000) return { err: 'Подождите 30 секунд перед повторной отправкой' };
  const code = String(100000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900000), on = await botOn(DB, env), exp = Date.now() + +(await cfg(DB)).code_ttl * 60000;
  if (on) {
    try { await bot(DB, env, 'sendMessage', { chat_id: await chatOf(DB, u), text: `Код входа: ${code}\nНикому не сообщайте.` }); }
    catch (e) { return { err: `Не удалось отправить код. Откройте бота @${(await cfg(DB)).bot}, нажмите Start и повторите.` }; }
  }
  const st = [DB.prepare('INSERT INTO codes(username,hash,exp,tries,sent) VALUES(?1,?2,?3,0,?4) ON CONFLICT(username) DO UPDATE SET hash=excluded.hash,exp=excluded.exp,tries=0,sent=excluded.sent').bind(u, await sha(code + ':' + u), exp, Date.now())];
  if (!on) st.push(DB.prepare('INSERT INTO vreq(username,code,exp,sent) VALUES(?1,?2,?3,0) ON CONFLICT(username) DO UPDATE SET code=excluded.code,exp=excluded.exp,sent=0').bind(u, code, exp));
  await DB.batch(st);
  return { manual: !on, bot: (await cfg(DB)).bot };
}
const newTok = (pre = '') => pre + crypto.randomUUID() + crypto.randomUUID();

export default {
  async scheduled(ev, env, ctx) {
    ctx.waitUntil((async () => {
      await ensure(env.DB);
      for (let i = 0; i < 4; i++) { await pollBot(env.DB, env); if (i < 3) await new Promise(r => setTimeout(r, 14000)); }
    })());
  },
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);
    try { await ensure(env.DB); return await route(req, env, p.slice(5)); } catch (e) { return E('Ошибка сервера', 500); }
  }
};

async function route(req, env, p) {
  const DB = env.DB;
  let b = {};
  if (req.method === 'POST') { try { b = await req.json(); } catch {} }

  // Публичная отдача фото (id неугадываемый, файлы кэшируются навсегда)
  if (req.method === 'GET' && p.startsWith('img/')) {
    const id = p.slice(4);
    if (!IMG_RE.test(id)) return E('Не найдено', 404);
    const f = await DB.prepare('SELECT mime,data FROM imgs WHERE id=?').bind(id).first();
    if (!f) return E('Не найдено', 404);
    const bin = atob(f.data), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Response(arr, { headers: { 'content-type': f.mime, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
  }

  if (p === 'auth/start' || p === 'auth/forgot') {
    const u = cl(b.username);
    if (u.length < 3) return E('Юзернейм минимум 3 символа');
    { const bm = await banMsg(DB, u); if (bm) return E(bm, 403); }
    const hasAcc = !!(await DB.prepare('SELECT 1 x FROM accounts WHERE name=?').bind(u).first());
    // Вход владельца без бота: код некому отправить, поэтому подтверждаем паролем администратора (секрет ADMIN_PASSWORD)
    if (u === OWNER && (env.ADMIN_PASSWORD || await DB.prepare("SELECT 1 x FROM settings WHERE k='pass'").first()) && (p === 'auth/forgot' || !hasAcc)) return J({ step: 'owner' });
    if (p === 'auth/start' && hasAcc) return J({ step: 'password' });
    const r = await issueCode(DB, env, u);
    if (r.err) return E(r.err);
    return J({ step: 'code', manual: r.manual, bot: r.bot });
  }

  if (p === 'auth/owner') {
    const lock = +((await DB.prepare("SELECT v FROM settings WHERE k='olock'").first())?.v || 0);
    if (lock > Date.now()) return E('Слишком много попыток. Подождите 15 минут');
    if (!(await passOk(DB, env, b.password))) {
      const f = +((await DB.prepare("SELECT v FROM settings WHERE k='ofail'").first())?.v || 0) + 1;
      await setK(DB, 'ofail', f >= 5 ? 0 : f);
      await setK(DB, 'olock', f >= 5 ? Date.now() + 900000 : 0);
      return E('Неверный пароль администратора');
    }
    const t = newTok('pw-');
    await DB.batch([
      DB.prepare("DELETE FROM settings WHERE k IN ('ofail','olock')"),
      DB.prepare('INSERT OR IGNORE INTO users(name,bal) VALUES(?,0)').bind(OWNER),
      DB.prepare('INSERT INTO sessions(token,user,adm,created) VALUES(?,?,0,?)').bind(t, OWNER, Date.now())
    ]);
    return J({ token: t });
  }

  if (p === 'auth/password') {
    const u = cl(b.username);
    { const bm = await banMsg(DB, u); if (bm) return E(bm, 403); }
    const a = await DB.prepare('SELECT pw,fails,lock FROM accounts WHERE name=?').bind(u).first();
    if (!a) return E('Аккаунт не найден');
    if (a.lock > Date.now()) return E('Слишком много попыток. Подождите 15 минут или сбросьте пароль');
    const [sl, x] = a.pw.split(':');
    if ((await pwHash(String(b.password || ''), sl)) !== x) {
      const f = a.fails + 1;
      await DB.prepare('UPDATE accounts SET fails=?1, lock=?2 WHERE name=?3').bind(f >= 5 ? 0 : f, f >= 5 ? Date.now() + 900000 : 0, u).run();
      return E('Неверный пароль');
    }
    const t = newTok();
    await DB.batch([
      DB.prepare('UPDATE accounts SET fails=0, lock=0 WHERE name=?').bind(u),
      DB.prepare('INSERT INTO sessions(token,user,adm,created) VALUES(?,?,0,?)').bind(t, u, Date.now())
    ]);
    return J({ token: t });
  }

  if (p === 'login/verify') {
    const u = cl(b.username), c = String(b.code || '').trim();
    { const bm = await banMsg(DB,
