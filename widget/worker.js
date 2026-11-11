/* WiseWallet — Cloudflare Worker для виджета на айфоне (v4.46)
 *
 * Зачем он нужен. Виджет-приложения на iOS (Widgy и подобные) умеют
 * забрать JSON по ссылке и разложить его по текстовым слоям. Ходить
 * напрямую в Supabase они не могут: там RLS, нужен токен пользователя,
 * а токен живёт час и его негде обновлять. Worker закрывает этот разрыв —
 * он единственный, кто знает сервисный ключ, и отдаёт наружу только
 * несколько уже посчитанных строк по секретной ссылке.
 *
 * Второе его дело — считать всё, что зависит от текущего момента.
 * Приложение кладёт в базу ФАКТЫ: дату последней записи и длину серии.
 * «Не вносил три дня» считается здесь, в момент запроса. Иначе после
 * трёх дней молчания в базе так и лежала бы цифра, записанная в
 * последний день, когда приложение вообще что-то отправляло, — и виджет
 * бодро показывал бы «0 дней» ровно тогда, когда должен напоминать.
 *
 * Развёртывание:
 *   npx wrangler deploy
 *   npx wrangler secret put SUPABASE_URL      → https://xxxx.supabase.co
 *   npx wrangler secret put SERVICE_KEY       → service_role из Project Settings → API
 *   npx wrangler secret put USER_ID           → свой uuid (Authentication → Users)
 *   npx wrangler secret put READ_KEY          → длинная случайная строка, придумать самому
 *
 * Проверка:  https://<worker>.workers.dev/?k=<READ_KEY>
 *
 * О безопасности. Сервисный ключ обходит RLS, поэтому он лежит только в
 * секретах Cloudflare и никогда не уходит в ответ. Worker умеет ровно
 * один запрос — прочитать колонку summary одной конкретной строки, —
 * и больше ничего: ни записи, ни произвольных таблиц. Ссылку с READ_KEY
 * стоит считать паролем: кто её знает, тот видит эти несколько чисел.
 * Сменить ключ — заново выполнить `wrangler secret put READ_KEY`.
 */

const TZ_DEFAULT = "Asia/Yekaterinburg";

/* Дата «сегодня» в часовом поясе человека, а не в UTC: Worker крутится
   неизвестно где, и под утро расхождение дало бы лишний день к счётчику. */
function todayIn(tz) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}
function daysBetween(from, to) {
  const a = Date.parse(from + "T00:00:00Z"), b = Date.parse(to + "T00:00:00Z");
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
/* Как в самом приложении: копейки показываем только когда они есть. */
function money(n) {
  const v = Math.round((+n || 0) * 100) / 100;
  const abs = Math.abs(v);
  const whole = Math.trunc(abs).toLocaleString("ru-RU");
  const kop = Number.isInteger(abs) ? "" : "," + abs.toFixed(2).split(".")[1];
  return (v < 0 ? "−" : "") + whole + kop + " ₽";
}

/* Напоминание в духе Duolingo: мягко в первый день, настойчивее дальше.
   Без чувства вины и без восклицательных знаков через один — приложение
   про деньги, а не тренер по продуктивности. */
function nag(days, streak, loggedToday, streakWas) {
  if (loggedToday) {
    return { state: "done", title: "Сегодня записано",
             text: streak > 1 ? "Серия: " + streak + " " + plural(streak, "день", "дня", "дней") : "Серия началась",
             mood: "ok" };
  }
  if (days === null) {
    return { state: "empty", title: "Пока ничего не записано", text: "Нажмите, чтобы внести первый расход", mood: "warn" };
  }
  if (days <= 1) {
    return { state: "due", title: "Сегодня ещё не записывали",
             text: streak > 0 ? "Серия " + streak + " " + plural(streak, "день", "дня", "дней") + " — не прерывайте" : "Нажмите, чтобы внести расход",
             mood: "warn" };
  }
  if (days <= 3) {
    return { state: "late", title: days + " " + plural(days, "день", "дня", "дней") + " без записей",
             text: streakWas > 1 ? "Серия из " + streakWas + " " + plural(streakWas, "дня", "дней", "дней") + " прервалась" : "Чем позже вносить, тем труднее вспомнить",
             mood: "warn" };
  }
  /* Про прерванную серию говорим по ТОЙ, что была до пропуска: к этому
     месту streak уже обнулён, и условие `streak > 0` никогда не сработало
     бы — сообщение «Серия прервалась» было недостижимым. */
  return { state: "cold", title: days + " " + plural(days, "день", "дня", "дней") + " без записей",
           text: streakWas > 1 ? "Серия из " + streakWas + " " + plural(streakWas, "дня", "дней", "дней") + " прервалась" : "Пора вернуться к учёту",
           mood: "alert" };
}

async function readSummary(env) {
  const url = env.SUPABASE_URL.replace(/\/+$/, "") +
    "/rest/v1/ww_user_state?user_id=eq." + encodeURIComponent(env.USER_ID) + "&select=summary";
  const r = await fetch(url, {
    headers: { apikey: env.SERVICE_KEY, Authorization: "Bearer " + env.SERVICE_KEY, Accept: "application/json" },
    cf: { cacheTtl: 0 },
  });
  if (!r.ok) throw new Error("Supabase HTTP " + r.status);
  const rows = await r.json();
  return (rows[0] && rows[0].summary) || null;
}

function build(summary, tzOverride) {
  const tz = tzOverride || (summary && summary.tz) || TZ_DEFAULT;
  const today = todayIn(tz);
  const last = summary && summary.lastEntry ? String(summary.lastEntry).slice(0, 10) : "";
  const days = last ? daysBetween(last, today) : null;
  const loggedToday = days === 0;

  /* Серия в базе записана на день последней записи. Жива она только если
     запись была сегодня или вчера — иначе день пропущен и счёт обнулён.
     Считать это в приложении нельзя: оно могло не запускаться неделю. */
  const streakWas = (summary && +summary.streak) || 0;
  let streak = streakWas;
  if (days === null || days > 1) streak = 0;

  const n = nag(days, streak, loggedToday, streakWas);
  const free = summary ? +summary.free || 0 : 0;
  const due = summary ? +summary.due || 0 : 0;
  const next = (summary && summary.next) || null;

  return {
    /* Готовые к показу строки: виджет-приложение не умеет ни считать,
       ни склонять, его дело — положить текст в слой. */
    title: n.title,
    text: n.text,
    state: n.state,                       /* done | due | late | cold | empty */
    mood: n.mood,                         /* ok | warn | alert — под цвет */
    icon: n.state === "done" ? "🔥" : n.state === "cold" ? "💤" : "✍️",
    streak: streak,
    streakText: streak > 0 ? streak + " " + plural(streak, "день", "дня", "дней") : "—",
    days: days === null ? -1 : days,
    daysText: days === null ? "—" : days === 0 ? "сегодня" : days + " " + plural(days, "день", "дня", "дней"),
    freeText: money(free),
    dueText: money(due),
    nextText: next ? next.name + " · " + money(next.amount) : "",
    nextDate: next ? next.date : "",
    updatedText: summary && summary.at ? new Date(+summary.at).toISOString().slice(0, 10) : "",
    /* Сырые числа — если захочется считать что-то своё. */
    free: free, due: due, balance: summary ? +summary.balance || 0 : 0,
    loggedToday: loggedToday,
  };
}

const PAGE = (d) => `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>WiseWallet — виджет</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#0d1117;
font:16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#e6edf3}
.c{width:320px;padding:22px;border-radius:22px;background:#161b22;border:1px solid #30363d}
.i{font-size:34px}.t{font-size:20px;font-weight:700;margin:10px 0 4px}
.s{color:#8b949e;font-size:14px}.r{display:flex;gap:18px;margin-top:18px;padding-top:16px;border-top:1px solid #30363d}
.r div{flex:1}.k{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.v{font-size:17px;font-weight:700;margin-top:3px}
.m-ok{color:#3fb950}.m-warn{color:#d29922}.m-alert{color:#f85149}</style></head>
<body><div class="c"><div class="i">${d.icon}</div><div class="t m-${d.mood}">${d.title}</div>
<div class="s">${d.text}</div><div class="r"><div><div class="k">Серия</div><div class="v">${d.streakText}</div></div>
<div><div class="k">Свободно</div><div class="v">${d.freeText}</div></div></div>
<div class="r"><div><div class="k">Осталось оплатить</div><div class="v">${d.dueText}</div></div></div>
</div></body></html>`;

export default {
  async fetch(request, env) {
    const u = new URL(request.url);

    if (!env.READ_KEY || !env.SUPABASE_URL || !env.SERVICE_KEY || !env.USER_ID) {
      return new Response("Worker не настроен: нужны секреты SUPABASE_URL, SERVICE_KEY, USER_ID, READ_KEY", { status: 500 });
    }
    /* Сравнение постоянного времени тут излишне: ключ длинный и
       случайный, а Cloudflare и так ограничивает частоту запросов. */
    if (u.searchParams.get("k") !== env.READ_KEY) {
      return new Response("Нужен параметр k с ключом доступа", { status: 401 });
    }

    let data;
    try {
      data = build(await readSummary(env), u.searchParams.get("tz"));
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e.message || e) }), {
        status: 502, headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    /* Минута кэша: виджеты обновляются по расписанию системы, чаще раза в
       минуту смысла нет, а база лишний раз не дёргается. */
    const headers = { "cache-control": "public, max-age=60" };

    if (u.pathname === "/preview" || u.searchParams.get("format") === "html") {
      return new Response(PAGE(data), { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
    }
    return new Response(JSON.stringify(data, null, 1), {
      headers: { ...headers, "content-type": "application/json; charset=utf-8" },
    });
  },
};
