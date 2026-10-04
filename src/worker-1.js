const OWNER = 'gold';
const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
const E = (m, s = 400) => J({ error: m }, s);
const cl = s => String(s || '').replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
const rnd = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const API = 'https://unixgram.com'; // Bot API Unixgram (формат как у Telegram): /api/bot/{token}/{method}
const SPEED = 0.00012; // рост множителя Rockets: exp(SPEED * мс)

async function hash(pw, salt) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100000, hash: 'SHA-256' }, k, 256));
}
async function passOk(DB, env, pw) {
  pw = String(pw || '');
  const h = await DB.prepare("SELECT v FROM settings WHERE k='pass'").first();
  if (h) { const [s, x] = h.v.split(':'); return (await hash(pw, s)) === x; }
  return !!env.ADMIN_PASSWORD && pw === env.ADMIN_PASSWORD;
}
async function cfg(DB) {
  const o = { dep_fee: '5', sell_fee: '5', bot: 'unixbot', recv: 'unix_stars_bank', rtp: '97', r1: '0', rmax: '1000' };
  for (const x of (await DB.prepare("SELECT k,v FROM settings WHERE k NOT IN ('pass','token')").all()).results) o[x.k] = x.v;
  return o;
}
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
  } else if (typeof m.text === 'string' && m.text.startsWith('/start')) {
    try { await bot(DB, env, 'sendMessage', { chat_id: m.chat.id, text: 'Это бот сайта. Вернитесь на сайт и запросите код входа.' }); } catch {}
  }
  return J({ ok: 1 });
}
const botOn = async (DB, env) => !!((await DB.prepare("SELECT v FROM settings WHERE k='token'").first())?.v || env.BOT_TOKEN);
const isAdm = async (DB, u) => u === OWNER || !!(await DB.prepare('SELECT 1 x FROM admins WHERE name=?').bind(u).first());

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);
    try { return await route(req, env, p.slice(5)); } catch (e) { return E('Ошибка сервера', 500); }
  }
};

async function route(req, env, p) {
  const DB = env.DB;
  let b = {};
  if (req.method === 'POST') { try { b = await req.json(); } catch {} }

  if (p === 'login') {
    const u = cl(b.username);
    if (u.length < 3) return E('Юзернейм минимум 3 символа');
    if (!(await botOn(DB, env))) { // режим без бота: вход только по юзернейму
      const t = crypto.randomUUID() + crypto.randomUUID();
      await DB.batch([
        DB.prepare('INSERT OR IGNORE INTO users(name,bal) VALUES(?,0)').bind(u),
        DB.prepare('INSERT INTO sessions(token,user,adm,created) VALUES(?,?,0,?)').bind(t, u, Date.now())
      ]);
      return J({ token: t });
    }
    const old = await DB.prepare('SELECT sent FROM codes WHERE username=?').bind(u).first();
    if (old && Date.now() - old.sent < 30000) return E('Подождите 30 секунд перед повторной отправкой');
    const code = String(100000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900000);
    try {
      await bot(DB, env, 'sendMessage', { chat_id: await chatOf(DB, u), text: `Код входа: ${code}\nНикому не сообщайте.` });
    } catch (e) {
      const c = await cfg(DB);
      return E(e.message === 'Бот не подключён' ? e.message : `Не удалось отправить код. Откройте бота @${c.bot}, нажмите Start и повторите.`);
    }
    await DB.prepare('INSERT INTO codes(username,hash,exp,tries,sent) VALUES(?1,?2,?3,0,?4) ON CONFLICT(username) DO UPDATE SET hash=excluded.hash,exp=excluded.exp,tries=0,sent=excluded.sent')
      .bind(u, await sha(code + ':' + u), Date.now() + 300000, Date.now()).run();
    return J({ sent: 1, bot: (await cfg(DB)).bot });
  }

  if (p === 'login/verify') {
    const u = cl(b.username), c = String(b.code || '').trim();
    const r = await DB.prepare('SELECT hash,exp,tries FROM codes WHERE username=?').bind(u).first();
    if (!r || r.exp < Date.now()) return E('Код истёк, запросите новый');
    if (r.tries >= 5) { await DB.prepare('DELETE FROM codes WHERE username=?').bind(u).run(); return E('Слишком много попыток, запросите новый код'); }
    if ((await sha(c + ':' + u)) !== r.hash) { await DB.prepare('UPDATE codes SET tries=tries+1 WHERE username=?').bind(u).run(); return E('Неверный код'); }
    const t = crypto.randomUUID() + crypto.randomUUID();
    await DB.batch([
      DB.prepare('DELETE FROM codes WHERE username=?').bind(u),
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

  if (p.startsWith('admin/') && p !== 'admin/login') {
    if (!(s.adm === 1 && await isAdm(DB, u))) return E('Нет доступа', 403);
  }

  switch (p) {
    case 'logout':
      await DB.prepare('DELETE FROM sessions WHERE token=?').bind(t).run();
      return J({ ok: 1 });

    case 'state': {
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
        cfg: { dep_fee: +c.dep_fee, sell_fee: +c.sell_fee, bot: c.bot, recv: c.recv, botOn: await botOn(DB, env) },
        canAdm: adm, adm: adm && s.adm === 1, owner: u === OWNER
      });
    }

    case 'case/open': {
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
      if (!(a > 0 && a <= 1e9)) return E('Неверная сумма');
      const r = await DB.batch([
        DB.prepare('UPDATE users SET bal=bal-?1 WHERE name=?2 AND bal>=?1').bind(a, u),
        DB.prepare("INSERT INTO reqs(user,type,amount,created) SELECT ?1,'stars',?2,?3 WHERE changes()>0").bind(u, a, Date.now())
      ]);
      if (!r[0].meta.changes) return E('Недостаточно звёзд');
      return J({ ok: 1 });
    }

    case 'deposit': {
      if (!(await botOn(DB, env))) { // режим без бота: заявка, админ сверяет перевод вручную
        const a0 = Math.floor(+b.amount), f = cl(b.from);
        if (!(a0 > 0 && a0 <= 1e7) || f.length < 3) return E('Укажите юзернейм и сумму');
        const n0 = await DB.prepare("SELECT COUNT(*) n FROM reqs WHERE user=? AND status='new'").bind(u).first();
        if (n0.n >= 10) return E('Слишком много открытых заявок');
        await DB.prepare("INSERT INTO reqs(user,type,amount,from_user,created) VALUES(?,'dep',?,?,?)").bind(u, a0, f, Date.now()).run();
        return J({ ok: 1 });
      }
      const a = Math.floor(+b.amount);
      if (!(a >= 1 && a <= 100000)) return E('Сумма от 1 до 100000');
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
      if (!(bet >= 1 && bet <= 1e6)) return E('Неверная ставка');
      const cur = await DB.prepare("SELECT id,crash,t0 FROM rockets WHERE user=? AND status='active'").bind(u).first();
      if (cur) {
        if (Math.exp(SPEED * (Date.now() - cur.t0)) < cur.crash) return E('Раунд уже идёт');
        await DB.prepare("UPDATE rockets SET status='crashed' WHERE id=?").bind(cur.id).run();
      }
      const c = await cfg(DB), rtp = Math.min(100, Math.max(50, +c.rtp)), mx = Math.min(10000, Math.max(2, +c.rmax)), r1 = Math.min(90, Math.max(0, +c.r1));
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
      return J({ reqs: rq, admins: ad, cfg: await cfg(DB) });
    }

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
      const num = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(+v) || 0));
      const kv = {
        dep_fee: num(b.dep_fee, 0, 100), sell_fee: num(b.sell_fee, 0, 100), rtp: num(b.rtp, 50, 100), r1: num(b.r1, 0, 90), rmax: num(b.rmax, 2, 10000),
        bot: cl(b.bot) || 'unixbot', recv: cl(b.recv) || 'unix_stars_bank'
      };
      await DB.batch(Object.entries(kv).map(([k, v]) =>
        DB.prepare('INSERT INTO settings(k,v) VALUES(?1,?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, String(v))));
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
      if (!/^[\w:\-]{10,200}$/.test(tk)) return E('Неверный токен');
      if (!env.WEBHOOK_SECRET) return E('Не задан секрет WEBHOOK_SECRET');
      const r = await fetch(`${API}/api/bot/${tk}/setWebhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: new URL(req.url).origin + '/api/bot/hook', secret_token: env.WEBHOOK_SECRET }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false) return E(d.description || 'setWebhook не удался');
      await DB.prepare("INSERT INTO settings(k,v) VALUES('token',?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(tk).run();
      return J({ ok: 1 });
    }

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
