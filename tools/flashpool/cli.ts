// flashpool: runs many SMALL single-shot jobs on DeepSeek V4 Flash (free) through every OrcaRouter account that
// OpenCode holds, in parallel. The free tier caps one request at ~32k tokens (measured 2026-10-17: 17.7k passes,
// ~35k is refused), so a job must be a bounded prompt (instruction + a few file slices) that returns one answer;
// it is NOT an agent loop. Keys are read at run time from OpenCode's credential table (never printed, never written).
//
//   node tools/flashpool/cli.ts status                         which accounts answer
//   node tools/flashpool/cli.ts run <jobs.json> <outDir>       run the jobs, write <outDir>/<id>.txt (+ <id>.code when extract is set)
//
// jobs.json = { "jobs": [ { "id": "fisher", "prompt": "...", "include": ["C:/abs/file.pas:120-260", "C:/abs/x.ts"],
//   "system": "...", "maxTokens": 6000, "extract": "ts" } ] }.  include = absolute paths, optional :from-to line range.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

const DB = 'C:/Users/me/.local/share/opencode/opencode.db';
const URL = 'https://api.orcarouter.ai/v1/chat/completions';
const MODEL = 'deepseek/deepseek-v4-flash-free';
const MAX_PROMPT_TOKENS = 24000; // estimate (chars / 3.4); the measured hard cap is ~32k including the answer
const PER_ACCOUNT = 2; // requests in flight per account

interface Account { label: string; key: string; used: number; failed: number; cooldownUntil: number }
interface Job { id: string; prompt: string; include?: string[]; system?: string; maxTokens?: number; extract?: string }

function loadAccounts(): Account[] {
  const fromEnv = process.env.ORCA_KEYS;
  if (fromEnv) return fromEnv.split(',').map((k, i) => ({ label: 'env' + (i + 1), key: k.trim(), used: 0, failed: 0, cooldownUntil: 0 })).filter((a) => a.key);
  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = db.prepare("select label, value from credential where integration_id = 'orcarouter' order by time_created").all() as { label: string; value: string }[];
  const out: Account[] = [];
  for (const r of rows) {
    let s = String(r.value).trim();
    if (s.startsWith('{')) { try { const j = JSON.parse(s); s = j.key ?? j.apiKey ?? j.api_key ?? j.token ?? ''; } catch { s = ''; } }
    if (s) out.push({ label: r.label, key: s, used: 0, failed: 0, cooldownUntil: 0 });
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const estTokens = (s: string) => Math.ceil(s.length / 3.4);

function readInclude(spec: string): string {
  const m = /^(.*?)(?::(\d+)-(\d+))?$/.exec(spec);
  const path = m !== null && m[1] !== undefined ? m[1] : spec;
  if (!isAbsolute(path)) throw new Error('include must be an absolute path: ' + spec);
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const from = m !== null && m[2] !== undefined ? Number(m[2]) : 1;
  const to = m !== null && m[3] !== undefined ? Number(m[3]) : lines.length;
  const body = lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n');
  return `=== FILE ${path} lines ${from}-${Math.min(to, lines.length)} ===\n${body}\n=== END FILE ===`;
}

function buildPrompt(job: Job): string {
  const parts: string[] = [];
  for (const inc of job.include ?? []) parts.push(readInclude(inc));
  parts.push(job.prompt);
  return parts.join('\n\n');
}

async function callOnce(acc: Account, job: Job, prompt: string): Promise<{ ok: boolean; status: number; text: string; usage?: unknown; retry: boolean; msg?: string }> {
  const messages: { role: string; content: string }[] = [];
  if (job.system) messages.push({ role: 'system', content: job.system });
  messages.push({ role: 'user', content: prompt });
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + acc.key },
    // the model reasons first and the reasoning counts against max_tokens: never go below 2000
    body: JSON.stringify({ model: MODEL, max_tokens: Math.max(job.maxTokens ?? 6000, 2000), messages }),
  });
  const raw = await res.text();
  let j: { choices?: { message?: { content?: string } }[]; error?: { message?: string }; usage?: unknown } = {};
  try { j = JSON.parse(raw); } catch { /* keep raw */ }
  const content = j.choices?.[0]?.message?.content;
  if (res.status === 200 && typeof content === 'string' && content.trim() !== '') return { ok: true, status: 200, text: content, usage: j.usage, retry: false };
  if (res.status === 200) return { ok: false, status: 200, text: '', retry: false, msg: 'empty answer (reasoning used the whole max_tokens): raise maxTokens' };
  const msg = String(j.error?.message ?? raw).slice(0, 200).split(acc.key).join('***');
  const tooLong = res.status === 400 && /longer than the free tier/i.test(msg);
  const retry = !tooLong && (res.status === 429 || res.status >= 500 || /capacity|limited|overloaded|try again/i.test(msg));
  return { ok: false, status: res.status, text: '', retry, msg };
}

function pickAccount(accs: Account[], inflight: Map<Account, number>): Account | null {
  const now = Date.now();
  let best: Account | null = null;
  for (const a of accs) {
    if (a.cooldownUntil > now) continue;
    const n = inflight.get(a) ?? 0;
    if (n >= PER_ACCOUNT) continue;
    if (best === null || n < (inflight.get(best) ?? 0) || (n === (inflight.get(best) ?? 0) && a.used < best.used)) best = a;
  }
  return best;
}

async function runJobs(jobsFile: string, outDir: string): Promise<number> {
  const accs = loadAccounts();
  if (accs.length === 0) { console.log('no OrcaRouter credentials found'); return 1; }
  mkdirSync(outDir, { recursive: true });
  const jobs: Job[] = (JSON.parse(readFileSync(jobsFile, 'utf8')) as { jobs: Job[] }).jobs;
  const queue = jobs.map((j) => ({ job: j, tries: 0 }));
  const inflight = new Map<Account, number>();
  const results: { id: string; ok: boolean; acct: string; tokens: number; note: string }[] = [];
  let active = 0;
  console.log(`flashpool: ${jobs.length} jobs, ${accs.length} accounts (${accs.map((a) => a.label).join(', ')}), model ${MODEL}`);

  await new Promise<void>((done) => {
    const pump = (): void => {
      while (queue.length > 0) {
        const acc = pickAccount(accs, inflight);
        if (acc === null) break;
        const item = queue.shift();
        if (item === undefined) break;
        let prompt = '';
        try { prompt = buildPrompt(item.job); } catch (e) { results.push({ id: item.job.id, ok: false, acct: '-', tokens: 0, note: String((e as Error).message) }); continue; }
        const est = estTokens(prompt) + (item.job.system ? estTokens(item.job.system) : 0);
        if (est > MAX_PROMPT_TOKENS) { results.push({ id: item.job.id, ok: false, acct: '-', tokens: est, note: `prompt ~${est} tokens > ${MAX_PROMPT_TOKENS}: split the job` }); continue; }
        inflight.set(acc, (inflight.get(acc) ?? 0) + 1);
        active++;
        acc.used++;
        callOnce(acc, item.job, prompt).then((r) => {
          if (r.ok) {
            writeFileSync(join(outDir, item.job.id + '.txt'), r.text);
            if (item.job.extract !== undefined) {
              const m = new RegExp('```' + item.job.extract + '\\s*\\n([\\s\\S]*?)```', 'i').exec(r.text) ?? /```[a-z]*\s*\n([\s\S]*?)```/i.exec(r.text);
              if (m !== null && m[1] !== undefined) writeFileSync(join(outDir, item.job.id + '.code'), m[1]);
            }
            const u = r.usage as { total_tokens?: number } | undefined;
            results.push({ id: item.job.id, ok: true, acct: acc.label, tokens: u?.total_tokens ?? 0, note: '' });
          } else if (r.retry && item.tries < 5) {
            acc.failed++;
            acc.cooldownUntil = Date.now() + 4000 * 2 ** item.tries;
            item.tries++;
            queue.push(item);
          } else {
            acc.failed++;
            results.push({ id: item.job.id, ok: false, acct: acc.label, tokens: 0, note: `HTTP ${r.status}: ${r.msg ?? ''}` });
          }
        }).catch((e: Error) => {
          acc.failed++;
          if (item.tries < 3) { item.tries++; queue.push(item); } else results.push({ id: item.job.id, ok: false, acct: acc.label, tokens: 0, note: 'fetch: ' + e.message.slice(0, 120) });
        }).finally(() => {
          inflight.set(acc, (inflight.get(acc) ?? 1) - 1);
          active--;
          if (queue.length === 0 && active === 0) done(); else setTimeout(pump, 50);
        });
      }
      if (queue.length === 0 && active === 0) done();
    };
    pump();
    setInterval(() => { if (queue.length > 0) pump(); }, 1000).unref();
  });

  for (const r of results.sort((a, b) => a.id.localeCompare(b.id))) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.id.padEnd(28)} ${r.acct.padEnd(14)} tokens=${r.tokens} ${r.note}`);
  for (const a of accs) console.log(`account ${a.label}: ${a.used} calls, ${a.failed} retried/failed`);
  return results.every((r) => r.ok) ? 0 : 2;
}

async function status(): Promise<number> {
  const accs = loadAccounts();
  if (accs.length === 0) { console.log('no OrcaRouter credentials found'); return 1; }
  for (const a of accs) {
    const t = Date.now();
    const r = await callOnce(a, { id: 'ping', prompt: 'Reply with the single word OK.', maxTokens: 20 }, 'Reply with the single word OK.').catch((e: Error) => ({ ok: false, status: 0, text: '', retry: false, msg: e.message }));
    console.log(`${a.label}: ${r.ok ? 'OK' : 'FAIL'} HTTP ${r.status} ${Date.now() - t} ms ${r.ok ? r.text.trim().slice(0, 20) : r.msg ?? ''}`);
  }
  return 0;
}

const [cmd, a1, a2] = process.argv.slice(2);
if (cmd === 'status') process.exit(await status());
else if (cmd === 'run' && a1 !== undefined && a2 !== undefined) {
  if (!existsSync(a1)) { console.log('no such jobs file: ' + a1); process.exit(1); }
  process.exit(await runJobs(a1, a2));
} else { console.log('usage: node tools/flashpool/cli.ts status | run <jobs.json> <outDir>'); process.exit(1); }
