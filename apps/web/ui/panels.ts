// ui/panels.ts — the DOM panels of the game screen (B2A): build menu, house/school/barracks/store panel,
// group panel, resource bar, mode hint and toasts. Panels only read the sim and render buttons; a button
// click becomes an action (ui.ts act) that queues a Command. Buttons the v0 sim refuses are shown
// disabled with a reason, never as working buttons.
import type { EconomyWorld, EconHouse } from '../../../packages/sim/economy.ts';
import { HOUSE_NAMES, HT_NONE, STOCK_WARES, WARE_SHORT, SCHOOL_UNITS, BARRACKS_UNITS, houseName, unitName, wareName, houseStateText } from './model.ts';
import type { Mode, Tab, UiState } from './ui.ts';

export type ToastKind = 'info' | 'good' | 'warn' | 'bad';

export interface Panels {
  renderBuild(w: EconomyWorld, hand: number, st: UiState): void;
  renderInfo(w: EconomyWorld, hand: number, st: UiState): void;
  renderStock(w: EconomyWorld, hand: number): void;
  renderHint(mode: Mode, houseType: number, w: EconomyWorld | null): void;
  toast(text: string, kind: ToastKind): void;
  expire(now: number): void;
  setVisible(on: boolean): void;
}

const HT_STORE_ID = 11;
const HT_SCHOOL_ID = 13;
const HT_BARRACKS_ID = 21;
const TOAST_MS = 4500;
const TOAST_MAX = 6;
const V0_REFUSED = 'not in the v0 economy (the sim refuses this command)';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function button(act: string, label: string, opts: { on?: boolean; disabled?: string | false; cls?: string } = {}): string {
  const cls = `btn${opts.on === true ? ' on' : ''}${opts.cls !== undefined ? ' ' + opts.cls : ''}`;
  if (opts.disabled !== undefined && opts.disabled !== false) {
    return `<button class="${cls}" disabled title="${esc(opts.disabled)}">${label}</button>`;
  }
  return `<button class="${cls}" data-act="${act}">${label}</button>`;
}

function buildHtml(w: EconomyWorld, hand: number, st: UiState): string {
  const tabs: [Tab, string][] = [['houses', 'Houses'], ['roads', 'Roads'], ['fields', 'Fields']];
  const tabRow = tabs
    .map(([t, label]) => `<button class="tab${st.tab === t ? ' on' : ''}" data-act="tab:${t}">${label}</button>`)
    .join('');
  let body = '';
  if (st.tab === 'houses') {
    const items: string[] = [];
    for (let t = 0; t < HOUSE_NAMES.length; t++) {
      if (t === HT_NONE) continue;
      const spec = w.houseSpecOf(t);
      if (spec === undefined) continue;
      const unlocked = w.houseCanBuild(hand, t);
      const on = st.mode === 'house' && st.houseType === t;
      const label = `<b>${HOUSE_NAMES[t]}</b><span>W${spec.woodCost} S${spec.stoneCost}</span>`;
      items.push(
        unlocked
          ? `<button class="btn house${on ? ' on' : ''}" data-act="mode:house:${t}">${label}</button>`
          : `<button class="btn house" disabled title="locked: a building it needs is not finished yet">${label}</button>`,
      );
    }
    body = `<div class="grid">${items.join('')}</div>`;
  } else if (st.tab === 'roads') {
    body = `<div class="grid"><button class="btn wide${st.mode === 'road' ? ' on' : ''}" data-act="mode:road">Road: drag a line</button></div>`;
  } else {
    body =
      `<div class="grid">` +
      `<button class="btn wide${st.mode === 'corn' ? ' on' : ''}" data-act="mode:corn">Corn field: click a tile</button>` +
      `<button class="btn wide${st.mode === 'erase' ? ' on' : ''}" data-act="mode:erase">Remove a plan: click it</button>` +
      `</div>`;
  }
  const cancel = st.mode !== 'none' ? `<div class="foot">${button('cancel', 'Cancel (Esc)')}</div>` : '';
  return `<div class="tabs">${tabRow}</div><div class="scroll">${body}</div>${cancel}`;
}

function houseHtml(w: EconomyWorld, hand: number, h: EconHouse): string {
  const spec = w.houseSpecOf(h.typeId);
  const owner = h.owner === hand ? 'yours' : `hand ${h.owner}`;
  const hp = Math.round(w.houseHealth(h));
  const rows: string[] = [
    `<div class="row"><span>HP</span><b>${hp}/${w.houseMaxHealth(h)}</b></div>`,
    `<div class="row"><span>State</span><b>${houseStateText(h.buildState)}</b></div>`,
  ];
  if (h.buildState === 'done') rows.push(`<div class="row"><span>Worker</span><b>${h.workerUid !== 0 ? 'at work' : 'none'}</b></div>`);
  const wares: string[] = [];
  if (h.typeId === HT_STORE_ID) {
    for (let ware = 0; ware < 28; ware++) {
      const n = w.wareCount(h, ware);
      if (n > 0) wares.push(`<span class="chip">${wareName(ware)} <b>${n}</b></span>`);
    }
    rows.push(`<div class="row"><span>Stock</span><div class="chips">${wares.join('') || '<i>empty</i>'}</div></div>`);
  } else if (spec !== undefined) {
    spec.resIn.forEach((ware, i) => {
      if (ware >= 0) wares.push(`<span class="chip">in: ${wareName(ware)} <b>${h.wareIn[i] ?? 0}</b></span>`);
    });
    spec.resOut.forEach((ware, i) => {
      if (ware >= 0) wares.push(`<span class="chip">out: ${wareName(ware)} <b>${h.wareOut[i] ?? 0}</b></span>`);
    });
    if (wares.length > 0) rows.push(`<div class="row"><span>Wares</span><div class="chips">${wares.join('')}</div></div>`);
  }
  const extra: string[] = [];
  if (h.typeId === HT_SCHOOL_ID && h.buildState === 'done') {
    const q = w.schoolQueueOf(h.uid);
    const free = q.slice(1).filter((v) => v === -1).length;
    const names = q.map((v, i) => (v === -1 ? '-' : `${i === 0 ? 'training ' : ''}${unitName(v)}`));
    rows.push(`<div class="row"><span>Queue</span><div class="chips">${names.filter((n) => n !== '-').map((n) => `<span class="chip">${n}</span>`).join('') || '<i>empty</i>'}</div></div>`);
    rows.push(`<div class="row"><span>Free slots</span><b>${free}</b></div>`);
    const btns = SCHOOL_UNITS.map((t) => {
      const disabled = free === 0 ? 'queue is full (5 slots)' : false;
      return button(`train:${t}`, unitName(t), { disabled });
    });
    extra.push(`<div class="sec">Train at the school</div><div class="grid3">${btns.join('')}</div>`);
  } else if (h.typeId === HT_SCHOOL_ID) {
    extra.push(`<div class="sec">The school is not finished yet</div>`);
  }
  if (h.typeId === HT_BARRACKS_ID && h.buildState === 'done') {
    rows.push(`<div class="row"><span>Recruits</span><b>${w.barracksRecruitCount(h.uid)}</b></div>`);
    const btns = BARRACKS_UNITS.map((t) => {
      const ok = w.barracksCanEquip(h.uid, t);
      return button(`equip:${t}`, unitName(t), { disabled: ok ? false : 'needs a recruit and the wares (axe, shield, armour, weapon...)' });
    });
    extra.push(`<div class="sec">Equip at the barracks</div><div class="grid3">${btns.join('')}</div>`);
  }
  const v0 = `title="${V0_REFUSED}"`;
  extra.push(
    `<div class="sec">Orders</div><div class="grid3">` +
      `<button class="btn" disabled ${v0}>Delivery mode</button>` +
      `<button class="btn" disabled ${v0}>Ware demand +/-</button>` +
      `<button class="btn" disabled ${v0}>Repair</button>` +
      `</div>`,
  );
  return (
    `<div class="title">${esc(houseName(h.typeId))} <span class="dim">· ${owner}</span></div>` +
    `<div class="rows">${rows.join('')}</div>${extra.join('')}` +
    `<div class="foot">${button('destroy', 'Destroy')}</div>`
  );
}

function groupsHtml(w: EconomyWorld, st: UiState): string {
  const blocks: string[] = [];
  let total = 0;
  let perRow = 0;
  let halted = false;
  for (const g of st.groups) {
    const grp = w.groupByUid(g);
    if (grp === null) continue;
    const counts = new Map<number, number>();
    let hp = 0;
    for (const m of grp.memberUids) {
      const u = w.unitByUid(m);
      if (u === null || u.dead) continue;
      counts.set(u.type, (counts.get(u.type) ?? 0) + 1);
      hp += w.unitHealth(m);
    }
    const members = [...counts.entries()].map(([t, n]) => `<span class="chip">${unitName(t)} <b>x${n}</b></span>`).join('');
    // a halt is a walk order with walk kind 'halt' (combat.ts groupOrderHalt); the kind stays 'halt' after the group stops
    // and is reset by the next walk order, so it means "the last order was a halt"
    const isHalt = grp.orderWalkKind === 'halt' && (grp.order === 'walk' || grp.order === 'none');
    const order = isHalt ? 'halted'
      : grp.order === 'walk' ? 'walking'
        : grp.order === 'attackUnit' || grp.order === 'attackHouse' ? 'attacking' : 'idle';
    total += grp.memberUids.length;
    perRow = perRow === 0 ? grp.unitsPerRow : perRow;
    halted = halted || isHalt;
    blocks.push(`<div class="rows"><div class="row"><span>Members</span><div class="chips">${members || '<i>none</i>'}</div></div>` +
      `<div class="row"><span>Condition</span><b>${order}, health ${Math.round(hp)}</b></div></div>`);
  }
  if (blocks.length === 0) return '';
  return (
    `<div class="title">Group <span class="dim">· ${total} soldier${total === 1 ? '' : 's'}</span></div>` +
    blocks.join('') +
    `<div class="sec">Formation</div>` +
    `<div class="row"><span>Units per row</span><div class="chips">` +
    button('form:-1', '-') +
    `<b>${perRow}</b>` +
    button('form:1', '+') +
    `</div></div>` +
    `<div class="foot">${button('halt', halted ? 'Halted' : 'Halt', { cls: 'wide' })}${button('deselect', 'Clear selection')}</div>`
  );
}

function unitHtml(w: EconomyWorld, hand: number, uid: number): string {
  const u = w.unitByUid(uid);
  if (u === null || u.dead) return '';
  const owner = u.owner === hand ? 'yours' : `hand ${u.owner}`;
  return (
    `<div class="title">${esc(unitName(u.type))} <span class="dim">· ${owner}</span></div>` +
    `<div class="rows"><div class="row"><span>Health</span><b>${Math.round(w.unitHealth(uid))}</b></div></div>` +
    `<div class="foot">${button('deselect', 'Clear selection')}</div>`
  );
}

function infoHtml(w: EconomyWorld, hand: number, st: UiState): string {
  if (st.houseUid !== 0) {
    const h = w.houseByUid(st.houseUid);
    if (h !== null && !h.destroyed) return houseHtml(w, hand, h);
  }
  if (st.groups.length > 0) return groupsHtml(w, st);
  if (st.units.length > 0) return unitHtml(w, hand, st.units[0]!);
  return '';
}

function hintText(mode: Mode, houseType: number): string {
  switch (mode) {
    case 'house':
      return `Build ${houseName(houseType)}: green tile = valid, red = not here. Click to place, right-click or Esc cancels`;
    case 'road':
      return 'Roads: drag a line of tiles. Right-click or Esc cancels';
    case 'corn':
      return 'Corn field: click a tile. Right-click or Esc cancels';
    case 'erase':
      return 'Remove a plan: click it. Right-click or Esc cancels';
    default:
      return 'Click selects a house or soldier. Drag selects soldiers. Right-click orders the selected soldiers. Esc clears';
  }
}

export function createPanels(doc: Document, act: (name: string, value: string) => void): Panels {
  const buildEl = doc.getElementById('buildmenu') as HTMLDivElement;
  const infoEl = doc.getElementById('info') as HTMLDivElement;
  const stockEl = doc.getElementById('stock') as HTMLSpanElement;
  const hintEl = doc.getElementById('hint') as HTMLDivElement;
  const toastsEl = doc.getElementById('toasts') as HTMLDivElement;
  const minimapEl = doc.getElementById('minimap') as HTMLDivElement;
  let lastBuild = '';
  let lastInfo = '';
  let lastStock = '';
  let lastHint = '';

  const onClick = (e: Event): void => {
    const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (el === null || (el as HTMLButtonElement).disabled) return;
    const raw = el.getAttribute('data-act') ?? '';
    const at = raw.indexOf(':');
    if (at < 0) act(raw, '');
    else act(raw.slice(0, at), raw.slice(at + 1));
  };
  buildEl.addEventListener('click', onClick);
  infoEl.addEventListener('click', onClick);

  return {
    renderBuild(w, hand, st) {
      const unlocked: boolean[] = [];
      for (let t = 0; t < HOUSE_NAMES.length; t++) unlocked.push(w.houseCanBuild(hand, t));
      const sig = JSON.stringify([st.mode, st.houseType, st.tab, unlocked]);
      if (sig === lastBuild) return;
      lastBuild = sig;
      buildEl.innerHTML = buildHtml(w, hand, st);
    },
    renderInfo(w, hand, st) {
      const html = infoHtml(w, hand, st);
      if (html === lastInfo) return;
      lastInfo = html;
      infoEl.innerHTML = html;
      infoEl.classList.toggle('hide', html === '');
    },
    renderStock(w, hand) {
      const parts = STOCK_WARES.map((ware) => {
        const label = WARE_SHORT[ware] ?? wareName(ware);
        return `${label}=${w.handWareBalance(hand, ware)}`;
      });
      const text = parts.join('  ');
      if (text === lastStock) return;
      lastStock = text;
      stockEl.textContent = text;
      stockEl.title = STOCK_WARES.map((ware) => wareName(ware)).join(', ');
    },
    renderHint(mode, houseType) {
      const text = hintText(mode, houseType);
      if (text === lastHint) return;
      lastHint = text;
      hintEl.textContent = text;
    },
    toast(text, kind) {
      const el = doc.createElement('div');
      el.className = `toast k-${kind}`;
      el.textContent = text;
      el.setAttribute('data-exp', String(performance.now() + TOAST_MS));
      toastsEl.appendChild(el);
      while (toastsEl.children.length > TOAST_MAX) toastsEl.firstElementChild?.remove();
    },
    expire(now) {
      for (const el of Array.from(toastsEl.children)) {
        if (Number(el.getAttribute('data-exp')) < now) el.remove();
      }
    },
    setVisible(on) {
      buildEl.classList.toggle('hide', !on);
      infoEl.classList.add('hide');
      hintEl.classList.toggle('hide', !on);
      toastsEl.classList.toggle('hide', !on);
      minimapEl.classList.toggle('hide', !on);
      if (!on) {
        toastsEl.innerHTML = '';
        lastBuild = '';
        lastInfo = '';
        lastStock = '';
        lastHint = '';
      }
    },
  };
}
