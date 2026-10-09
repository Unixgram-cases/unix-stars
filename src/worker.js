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
  "CREATE TABLE IF NOT EXISTS users(name TEXT PRIMARY KEY, bal INTEGER NOT NULL DEFAULT 0 CHECK(bal>=0));",
  "CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user TEXT NOT NULL, adm INTEGER NOT NULL DEFAULT 0, created INTEGER);",
  "CREATE TABLE IF NOT EXISTS cases(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL, w REAL NOT NULL);",
  "CREATE TABLE IF NOT EXISTS inv(id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL);",
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
async function ensure(DB) { if (ready) return; await DB.batch(DDL.map(q => DB.prepare(q))); ready = true; }

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
  on_cases: [0, 1, 1], on_rocket: [0, 1, 1], on_mines: [0, 1, 1],
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
        DB.prepare('UPDATE users SET bal=bal+?1 WHERE name=?2 AND changes()>0').bind(get, d.user)
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

  if (p === 'auth/start' || p === 'auth/forgot') {
    const u = cl(b.username);
    if (u.length < 3) return E('Юзернейм минимум 3 символа');
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
    const r = await DB.prepare('SELECT hash,exp,tries FROM codes WHERE username=?').bind(u).first();
    if (!r || r.exp < Date.now()) return E('Код истёк, запросите новый');
    if (r.tries >= 5) { await DB.prepare('DELETE FROM codes WHERE username=?').bind(u).run(); return E('Слишком много попыток, запросите новый код'); }
    if ((await sha(c + ':' + u)) !== r.hash) { await DB.prepare('UPDATE codes SET tries=tries+1 WHERE username=?').bind(u).run(); return E('Неверный код'); }
    const t = newTok('pw-'); // сессия «до установки пароля»: доступно только задать пароль
    await DB.batch([
      DB.prepare('DELETE FROM codes WHERE username=?').bind(u),
      DB.prepare('DELETE FROM vreq WHERE username=?').bind(u),
      DB.prepare('INSERT OR IGNORE INTO users(name,bal) VALUES(?,0)').bind(u),
      DB.prepare('INSERT INTO sessions(token,user,adm,created) VALUES(?,?,0,?)').bind(t, u, Date.now())
    ]);
    return J({ token: t });
  }

  if (p === 'bot/hook') {
    if (!env.WEBHOOK_SECRET || req.headers.get('x-unixgram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return E('forbidden', 403);
    return hook(DB, env, b);
  }

  const t = (req.headers.get('authorization') || '').replace('Bearer ', '');
  const s = t && await DB.prepare('SELECT user,adm FROM sessions WHERE token=?').bind(t).first();
  if (!s) return E('Нужен вход', 401);
  const u = s.user;
  if (t.startsWith('pw-') && !['state', 'account/password', 'logout'].includes(p)) return E('Сначала установите пароль', 403);

  if (p.startsWith('admin/') && p !== 'admin/login') {
    if (!(s.adm === 1 && await isAdm(DB, u))) return E('Нет доступа', 403);
  }

  switch (p) {
    case 'account/password': {
      const pw = String(b.password || '');
      if (!t.startsWith('pw-')) return E('Подтвердите аккаунт кодом', 403);
      if (pw.length < 8 || pw.length > 128) return E('Пароль от 8 до 128 символов');
      const sl = crypto.randomUUID(), nt = newTok();
      await DB.batch([
        DB.prepare('INSERT INTO accounts(name,pw,fails,lock) VALUES(?1,?2,0,0) ON CONFLICT(name) DO UPDATE SET pw=excluded.pw,fails=0,lock=0').bind(u, sl + ':' + await pwHash(pw, sl)),
        DB.prepare('DELETE FROM sessions WHERE user=?').bind(u),
        DB.prepare('INSERT INTO sessions(token,user,adm,created) VALUES(?,?,0,?)').bind(nt, u, Date.now())
      ]);
      return J({ token: nt });
    }

    case 'logout':
      await DB.prepare('DELETE FROM sessions WHERE token=?').bind(t).run();
      return J({ ok: 1 });

    case 'state': {
      if (await DB.prepare("SELECT 1 x FROM deposits WHERE user=? AND status='new' AND created>?").bind(u, Date.now() - 900000).first()) await pollBot(DB, env);
      const [a, inv, cs, its, rq] = await DB.batch([
        DB.prepare('SELECT bal FROM users WHERE name=?').bind(u),
        DB.prepare('SELECT id,name,value FROM inv WHERE user=? ORDER BY id DESC').bind(u),
        DB.prepare('SELECT id,name,price FROM cases ORDER BY id'),
        DB.prepare('SELECT case_id,name,value,w FROM items ORDER BY id'),
        DB.prepare('SELECT id,type,amount,from_user,item_name,item_value,status FROM reqs WHERE user=? ORDER BY id DESC LIMIT 30').bind(u)
      ]);
      const c = await cfg(DB), adm = await isAdm(DB, u);
      return J({
        user: u, bal: a.results[0]?.bal || 0, inv: inv.results, reqs: rq.results,
        cases: cs.results.map(x => ({ ...x, items: its.results.filter(i => i.case_id === x.id) })),
        cfg: {
          dep_fee: +c.dep_fee, sell_fee: +c.sell_fee, bot: c.bot, recv: c.recv, botOn: await botOn(DB, env), site: c.site, dmin: +c.dmin, wmin: +c.wmin,
          on: { cases: +c.on_cases === 1, rocket: +c.on_rocket === 1, mines: +c.on_mines === 1 },
          rb: [+c.rbmin, +c.rbmax],
          m: { n: +c.mn, min: Math.max(1, +c.mmin), max: Math.min(+c.mmax, +c.mn * +c.mn - 1), bmin: +c.mbmin, bmax: +c.mbmax }
        },
        needPw: t.startsWith('pw-'), canAdm: adm, adm: adm && s.adm === 1, owner: u === OWNER
      });
    }

    case 'case/open': {
      if (+(await cfg(DB)).on_cases !== 1) return E('Кейсы отключены');
      const c = await DB.prepare('SELECT id,price FROM cases WHERE id=?').bind(+b.id).first();
      if (!c) return E('Кейс не найден');
      const its = (await DB.prepare('SELECT name,value,w FROM items WHERE case_id=?').bind(c.id).all()).results;
      const sum = its.reduce((a, x) => a + x.w, 0);
      if (!its.length || sum <= 0) return E('Кейс пуст');
      let r = rnd() * sum, it = its[its.length - 1];
      for (const i of its) { if ((r -= i.w) < 0) { it = i; break; } }
      const st = [DB.prepare('UPDATE users SET bal=bal-?1 WHERE name=?2 AND bal>=?1').bind(c.price, u)];
      if (it.value > 0) st.push(DB.prepare('INSERT INTO inv(user,name,value) SELECT ?1,?2,?3 WHERE changes()>0').bind(u, it.name, it.value));
      const res = await DB.batch(st);
      if (!res[0].meta.changes) return E('Недостаточно звёзд');
      return J({ item: { name: it.name, value: it.value } });
    }

    case 'inv/sell': {
      const it = await DB.prepare('SELECT id,value FROM inv WHERE id=? AND user=?').bind(+b.id, u).first();
      if (!it) return E('Предмет не найден');
      const c = await cfg(DB), get = Math.floor(it.value * (100 - +c.sell_fee) / 100), fee = it.value - get;
      const r = await DB.batch([
        DB.prepare('DELETE FROM inv WHERE id=?1 AND user=?2').bind(it.id, u),
        DB.prepare('UPDATE users SET bal=bal+?1 WHERE name=?2 AND changes()>0').bind(get, u),
        DB.prepare('UPDATE users SET bal=bal+?1 WHERE name=?2 AND changes()>0').bind(fee, OWNER)
      ]);
      if (!r[0].meta.changes) return E('Предмет уже продан');
      return J({ get });
    }

    case 'inv/withdraw': {
      const it = await DB.prepare('SELECT id,name,value FROM inv WHERE id=? AND user=?').bind(+b.id, u).first();
      if (!it) return E('Предмет не найден');
      const r = await DB.batch([
        DB.prepare('DELETE FROM inv WHERE id=?1 AND user=?2').bind(it.id, u),
        DB.prepare("INSERT INTO reqs(user,type,item_name,item_value,created) SELECT ?1,'item',?2,?3,?4 WHERE changes()>0").bind(u, it.name, it.value, Date.now())
      ]);
      if (!r[0].meta.changes) return E('Предмет не найден');
      return J({ ok: 1 });
    }

    case 'withdraw': {
      const a = Math.floor(+b.amount);
      const wm = +(await cfg(DB)).wmin;
      if (!(a > 0 && a <= 1e9) || a < wm) return E(wm ? `Минимум ${wm} ⭐` : 'Неверная сумма');
      const r = await DB.batch([
        DB.prepare('UPDATE users SET bal=bal-?1 WHERE name=?2 AND bal>=?1').bind(a, u),
        DB.prepare("INSERT INTO reqs(user,type,amount,created) SELECT ?1,'stars',?2,?3 WHERE changes()>0").bind(u, a, Date.now())
      ]);
      if (!r[0].meta.changes) return E('Недостаточно звёзд');
      return J({ ok: 1 });
    }

    case 'deposit': {
      const dm = +(await cfg(DB)).dmin;
      if (!(await botOn(DB, env))) { // режим без бота: заявка, админ сверяет перевод вручную
        const a0 = Math.floor(+b.amount), f = cl(b.from);
        if (!(a0 > 0 && a0 <= 1e7) || f.length < 3 || a0 < dm) return E(dm && a0 < dm ? `Минимум ${dm} ⭐` : 'Укажите юзернейм и сумму');
        const n0 = await DB.prepare("SELECT COUNT(*) n FROM reqs WHERE user=? AND status='new'").bind(u).first();
        if (n0.n >= 10) return E('Слишком много открытых заявок');
        await DB.prepare("INSERT INTO reqs(user,type,amount,from_user,created) VALUES(?,'dep',?,?,?)").bind(u, a0, f, Date.now()).run();
        return J({ ok: 1 });
      }
      const a = Math.floor(+b.amount);
      if (!(a >= Math.max(1, dm) && a <= 100000)) return E(`Сумма от ${Math.max(1, dm)} до 100000`);
      const n = await DB.prepare("SELECT COUNT(*) n FROM deposits WHERE user=? AND status='new' AND created>?").bind(u, Date.now() - 600000).first();
      if (n.n >= 5) return E('Слишком много неоплаченных счетов, подождите');
      const id = (await DB.prepare('INSERT INTO deposits(user,amount,created) VALUES(?,?,?)').bind(u, a, Date.now()).run()).meta.last_row_id;
      try {
        await bot(DB, env, 'sendInvoice', { chat_id: await chatOf(DB, u), title: 'Пополнение баланса', description: `${a} ⭐`, payload: 'dep:' + id, currency: 'XTR', prices: [{ label: 'Звёзды', amount: a }] });
      } catch (e) {
        await DB.prepare("UPDATE deposits SET status='failed' WHERE id=?").bind(id).run();
        return E('Не удалось отправить счёт: ' + e.message);
      }
      return J({ ok: 1 });
    }

    case 'rocket/start': {
      const bet = Math.floor(+b.bet);
      const c = await cfg(DB);
      if (+c.on_rocket !== 1) return E('Rockets отключена');
      if (!(bet >= +c.rbmin && bet <= +c.rbmax)) return E(`Ставка от ${c.rbmin} до ${c.rbmax}`);
      const cur = await DB.prepare("SELECT id,crash,t0 FROM rockets WHERE user=? AND status='active'").bind(u).first();
      if (cur) {
        if (Math.exp(SPEED * (Date.now() - cur.t0)) < cur.crash) return E('Раунд уже идёт');
        await DB.prepare("UPDATE rockets SET status='crashed' WHERE id=?").bind(cur.id).run();
      }
      const rtp = Math.min(100, Math.max(50, +c.rtp)), mx = Math.min(10000, Math.max(2, +c.rmax)), r1 = Math.min(90, Math.max(0, +c.r1));
      const crash = rnd() * 100 < r1 ? 1 : Math.min(mx, Math.max(1, Math.floor(rtp / (1 - rnd())) / 100));
      const r = await DB.batch([
        DB.prepare('UPDATE users SET bal=bal-?1 WHERE name=?2 AND bal>=?1').bind(bet, u),
        DB.prepare("INSERT INTO rockets(user,bet,crash,t0) SELECT ?1,?2,?3,?4 WHERE changes()>0").bind(u, bet, crash, Date.now())
      ]);
      if (!r[0].meta.changes) return E('Недостаточно звёзд');
      return J({ bet, m: 1 });
    }

    case 'rocket/status': {
      const q = await DB.prepare("SELECT id,bet,crash,t0 FROM rockets WHERE user=? AND status='active'").bind(u).first();
      if (!q) return J({ none: 1 });
      const m = Math.exp(SPEED * (Date.now() - q.t0));
      if (m >= q.crash) {
        await DB.prepare("UPDATE rockets SET status='crashed' WHERE id=?").bind(q.id).run();
        return J({ crashed: 1, crash: q.crash });
      }
      return J({ run: 1, m, bet: q.bet });
    }

    case 'rocket/cashout': {
      const q = await DB.prepare("SELECT id,bet,crash,t0 FROM rockets WHERE user=? AND status='active'").bind(u).first();
      if (!q) return E('Нет активного раунда');
      const m = Math.floor(Math.exp(SPEED * (Date.now() - q.t0)) * 100) / 100;
      if (m >= q.crash) {
        await DB.prepare("UPDATE rockets SET status='crashed' WHERE id=?").bind(q.id).run();
        return J({ crashed: 1, crash: q.crash });
      }
      const win = Math.floor(q.bet * m);
      const r = await DB.batch([
        DB.prepare("UPDATE rockets SET status='cashed' WHERE id=?1 AND status='active'").bind(q.id),
        DB.prepare('UPDATE users SET bal=bal+?1 WHERE name=?2 AND changes()>0').bind(win, u)
      ]);
      if (!r[0].meta.changes) return E('Раунд уже завершён');
      return J({ win, m });
    }

    // ---------- САПЁР ----------
    case 'mines/start': {
      const c = await cfg(DB);
      if (+c.on_mines !== 1) return E('Сапёр отключён');
      const n = +c.mn, tot = n * n, bet = Math.floor(+b.bet), mc = Math.floor(+b.mines);
      const lo = Math.max(1, +c.mmin), hi = Math.min(+c.mmax, tot - 1);
      if (!(bet >= +c.mbmin && bet <= +c.mbmax)) return E(`Ставка от ${c.mbmin} до ${c.mbmax}`);
      if (!(mc >= lo && mc <= hi)) return E(`Мин: от ${lo} до ${hi}`);
      if (await DB.prepare("SELECT id FROM mines WHERE user=? AND status='active'").bind(u).first()) return E('Игра уже идёт');
      const pos = [...Array(tot).keys()];
      for (let i = tot - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pos[i], pos[j]] = [pos[j], pos[i]]; }
      const r = await DB.batch([
        DB.prepare('UPDATE users SET bal=bal-?1 WHERE name=?2 AND bal>=?1').bind(bet, u),
        DB.prepare("INSERT INTO mines(user,bet,size,mc,pos,opened,created) SELECT ?1,?2,?3,?4,?5,'[]',?6 WHERE changes()>0").bind(u, bet, n, mc, JSON.stringify(pos.slice(0, mc)), Date.now())
      ]);
      if (!r[0].meta.changes) return E('Недостаточно звёзд');
      return J({ size: n, mc, bet, opened: [], mult: 1, next: mm(n, mc, 1, c) });
    }

    case 'mines/status': {
      const g = await DB.prepare("SELECT bet,size,mc,opened FROM mines WHERE user=? AND status='active'").bind(u).first();
      if (!g) return J({ none: 1 });
      const c = await cfg(DB), o = JSON.parse(g.opened);
      return J({ size: g.size, mc: g.mc, bet: g.bet, opened: o, mult: mm(g.size, g.mc, o.length, c), next: o.length < g.size * g.size - g.mc ? mm(g.size, g.mc, o.length + 1, c) : null });
    }

    case 'mines/open': {
      const g = await DB.prepare("SELECT id,bet,size,mc,pos,opened FROM mines WHERE user=? AND status='active'").bind(u).first();
      if (!g) return E('Нет активной игры');
      const tot = g.size * g.size, i = Math.floor(+b.i), o = JSON.parse(g.opened), pos = JSON.parse(g.pos);
      if (!(i >= 0 && i < tot)) return E('Неверная клетка');
      if (o.includes(i)) return E('Клетка уже открыта');
      if (pos.includes(i)) {
        await DB.prepare("UPDATE mines SET status='lost' WHERE id=? AND status='active'").bind(g.id).run();
        return J({ boom: 1, i, pos });
      }
      o.push(i);
      const c = await cfg(DB), mult = mm(g.size, g.mc, o.length, c);
      if (o.length >= tot - g.mc) { // открыты все безопасные клетки: автоматический вывод
        const win = Math.floor(g.bet * mult);
        const r = await DB.batch([
          DB.prepare("UPDATE mines SET status='cashed',opened=?1 WHERE id=?2 AND status='active'").bind(JSON.stringify(o), g.id),
          DB.prepare('UPDATE users SET bal=bal+?1 WHERE name=?2 AND changes()>0').bind(win, u)
        ]);
        if (!r[0].meta.changes) return E('Игра уже завершена');
        return J({ done: 1, win, mult, opened: o, pos });
      }
      const r = await DB.prepare("UPDATE mines SET opened=?1 WHERE id=?2 AND status='active'").bind(JSON.stringify(o), g.id).run();
      if (!r.meta.changes) return E('Игра уже завершена');
      return J({ safe: 1, opened: o, mult, next: mm(g.size, g.mc, o.length + 1, c) });
    }

    case 'mines/cashout': {
      const g = await DB.prepare("SELECT id,bet,size,mc,pos,opened FROM mines WHERE user=? AND status='active'").bind(u).first();
      if (!g) return E('Нет активной игры');
      const o = JSON.parse(g.opened);
      if (!o.length) return E('Откройте хотя бы одну клетку');
      const mult = mm(g.size, g.mc, o.length, await cfg(DB)), win = Math.floor(g.bet * mult);
      const r = await DB.batch([
        DB.prepare("UPDATE mines SET status='cashed' WHERE id=?1 AND status='active'").bind(g.id),
        DB.prepare('UPDATE users SET bal=bal+?1 WHERE name=?2 AND changes()>0').bind(win, u)
      ]);
      if (!r[0].meta.changes) return E('Игра уже завершена');
      return J({ win, mult, pos: JSON.parse(g.pos) });
    }

    // ---------- АДМИНКА ----------
    case 'admin/login': {
      if (!(await isAdm(DB, u))) return E('Нет доступа', 403);
      if (!(await passOk(DB, env, b.password))) return E('Неверный пароль', 403);
      await DB.prepare('UPDATE sessions SET adm=1 WHERE token=?').bind(t).run();
      return J({ ok: 1 });
    }

    case 'admin/data': {
      const rq = (await DB.prepare("SELECT id,user,type,amount,from_user,item_name,item_value FROM reqs WHERE status='new' ORDER BY id").all()).results;
      const ad = (await DB.prepare('SELECT name FROM admins ORDER BY name').all()).results.map(x => x.name);
      const vr = (await DB.prepare('SELECT username,code FROM vreq WHERE sent=0 AND exp>? ORDER BY exp').bind(Date.now()).all()).results;
      return J({ reqs: rq, admins: ad, vr, cfg: await cfg(DB) });
    }

    case 'admin/vsent':
      await DB.prepare('UPDATE vreq SET sent=1 WHERE username=?').bind(cl(b.u)).run();
      return J({ ok: 1 });

    case 'admin/req': {
      const q = await DB.prepare("SELECT * FROM reqs WHERE id=? AND status='new'").bind(+b.id).first();
      if (!q) return E('Заявка уже обработана');
      const ok = !!b.ok;
      const st = [DB.prepare("UPDATE reqs SET status=?1 WHERE id=?2 AND status='new'").bind(ok ? 'done' : 'no', q.id)];
      if (q.type === 'dep' && ok) {
        const c = await cfg(DB);
        st.push(DB.prepare('UPDATE users SET bal=bal+?1 WHERE name=?2 AND changes()>0').bind(Math.floor(q.amount * (100 - +c.dep_fee) / 100), q.user));
      }
      if (!ok && q.type === 'stars') st.push(DB.prepare('UPDATE users SET bal=bal+?1 WHERE name=?2 AND changes()>0').bind(q.amount, q.user));
      if (!ok && q.type === 'item') st.push(DB.prepare('INSERT INTO inv(user,name,value) SELECT ?1,?2,?3 WHERE changes()>0').bind(q.user, q.item_name, q.item_value));
      await DB.batch(st);
      return J({ ok: 1 });
    }

    case 'admin/case': {
      const name = String(b.name || '').slice(0, 60), price = Math.floor(+b.price);
      const its = (Array.isArray(b.items) ? b.items : []).slice(0, 50).map(i => ({ n: String(i.name || '').slice(0, 60), v: Math.max(0, Math.floor(+i.value || 0)), w: Math.max(0, +i.w || 0) }));
      if (!name || !(price >= 0) || !its.length) return E('Неверные данные кейса');
      const sum = its.reduce((a, x) => a + x.w, 0);
      its.forEach(x => x.w = sum > 0 ? +(x.w / sum * 100).toFixed(4) : 100 / its.length);
      let id = +b.id;
      const ins = x => DB.prepare('INSERT INTO items(case_id,name,value,w) VALUES(?,?,?,?)').bind(id, x.n, x.v, x.w);
      if (id) {
        await DB.batch([
          DB.prepare('UPDATE cases SET name=?,price=? WHERE id=?').bind(name, price, id),
          DB.prepare('DELETE FROM items WHERE case_id=?').bind(id),
          ...its.map(ins)
        ]);
      } else {
        id = (await DB.prepare('INSERT INTO cases(name,price) VALUES(?,?)').bind(name, price).run()).meta.last_row_id;
        await DB.batch(its.map(ins));
      }
      return J({ id });
    }

    case 'admin/case/delete':
      await DB.batch([
        DB.prepare('DELETE FROM items WHERE case_id=?').bind(+b.id),
        DB.prepare('DELETE FROM cases WHERE id=?').bind(+b.id)
      ]);
      return J({ ok: 1 });

    case 'admin/settings': {
      const kv = {};
      for (const k in SPEC) {
        if (b[k] === undefined) continue;
        const [lo, hi, d] = SPEC[k], v = Math.min(hi, Math.max(lo, Math.floor(+b[k])));
        kv[k] = Number.isFinite(v) ? v : d;
      }
      if (b.bot !== undefined) kv.bot = cl(b.bot) || 'unixbot';
      if (b.recv !== undefined) kv.recv = cl(b.recv) || 'unix_stars_bank';
      if (b.site !== undefined) kv.site = String(b.site).trim().slice(0, 30) || 'Unix Stars';
      if (Object.keys(kv).length) {
        await DB.batch(Object.entries(kv).map(([k, v]) =>
          DB.prepare('INSERT INTO settings(k,v) VALUES(?1,?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, String(v))));
      }
      return J({ ok: 1 });
    }

    case 'admin/admins': {
      if (u !== OWNER) return E('Только владелец', 403);
      const n = cl(b.name);
      if (n.length < 3 || n === OWNER) return E('Неверный юзернейм');
      if (b.remove) await DB.prepare('DELETE FROM admins WHERE name=?').bind(n).run();
      else await DB.prepare('INSERT OR IGNORE INTO admins(name) VALUES(?)').bind(n).run();
      return J({ ok: 1 });
    }

    case 'admin/bot': {
      if (u !== OWNER) return E('Только владелец', 403);
      const tk = String(b.token || '').trim();
      if (!/^[\w:\-]{10,200}$/.test(tk)) return E('Неверный формат токена');
      const call = async (m, p = {}) => {
        const r = await fetch(`${API}/api/bot/${tk}/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) });
        const raw = await r.text(); let d = {}; try { d = JSON.parse(raw); } catch {}
        if (!r.ok || d.ok === false) throw new Error(`${m}: ${d.description || ('HTTP ' + r.status + ' ' + raw.slice(0, 120))}`);
        return d.result;
      };
      let me;
      try { me = await call('getMe'); } catch (e) { return E('Токен не принят. ' + e.message); }
      try { await call('deleteWebhook'); } catch {}
      const name = cl(me?.username || '');
      await DB.batch([
        DB.prepare("INSERT INTO settings(k,v) VALUES('token',?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(tk),
        DB.prepare("DELETE FROM settings WHERE k IN ('offset','bot_err','last_upd')"),
        ...(name ? [DB.prepare("INSERT INTO settings(k,v) VALUES('bot',?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(name)] : [])
      ]);
      await pollBot(DB, env);
      return J({ ok: 1, name });
    }

    case 'admin/bot/off':
      if (u !== OWNER) return E('Только владелец', 403);
      await DB.prepare("DELETE FROM settings WHERE k IN ('token','offset','bot_err','last_upd')").run();
      return J({ ok: 1 });

    case 'admin/password': {
      if (u !== OWNER) return E('Только владелец', 403);
      const pw = String(b.password || '');
      if (pw.length < 8) return E('Минимум 8 символов');
      const salt = crypto.randomUUID();
      await DB.prepare("INSERT INTO settings(k,v) VALUES('pass',?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(salt + ':' + await hash(pw, salt)).run();
      return J({ ok: 1 });
    }
  }
  return E('Не найдено', 404);
}
