import { AgentKind } from '../model';
import { CardView, EmptyAction, GroupView, HostMessage, Scope, SCOPES, scopeLabel, SORT_KEYS, SortKey, sortLabel, ViewState, WebviewMessage } from '../protocol';
import { agentLabel, countOf, relativeTime } from '../view/format';

interface PersistedState {
  expanded: Record<string, boolean>;
}

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface GroupNode {
  key: string;
  section: HTMLElement;
  header: HTMLButtonElement;
  label: HTMLElement;
  badge: HTMLElement;
  body: HTMLElement;
  /** Whether `open` was decided for a search; expansion changed during a search is not persisted. */
  searching: boolean;
  open: boolean;
}

interface CardNode {
  json: string;
  node: HTMLElement;
}

const SEARCH_DELAY_MS = 150;
const CLOCK_INTERVAL_MS = 60_000;
const MAX_QUERY_LENGTH = 500;
const SVG_NS = 'http://www.w3.org/2000/svg';

type IconName = 'chevron' | 'more' | 'search' | 'close' | 'check' | 'sync' | 'warning' | 'branch' | AgentKind;

const ICONS: Record<IconName, string[]> = {
  chevron: ['M4 6l4 4 4-4'],
  more: ['M3 8h.01M8 8h.01M13 8h.01'],
  search: ['M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10z', 'M10.5 10.5L14 14'],
  close: ['M4 4l8 8M12 4l-8 8'],
  check: ['M3 8.5l3 3 7-7'],
  sync: ['M13 8a5 5 0 1 1-1.46-3.54', 'M13 2.5v2.5h-2.5'],
  warning: ['M8 2L1.5 13.5h13z', 'M8 6.5v3M8 11.5h.01'],
  branch: ['M5 2.5v8', 'M11 5.5c0 3-6 2.5-6 5', 'M5 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M11 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z'],
  claude: ['M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2'],
  codex: ['M8 1.5l5.6 3.25v6.5L8 14.5l-5.6-3.25v-6.5z', 'M6 6.5L8 8l-2 1.5M8.5 9.5H10'],
};

const EMPTY_ACTIONS: Record<EmptyAction, { label: string; message: WebviewMessage }> = {
  openSettings: { label: 'Open Settings', message: { type: 'openSettings' } },
  refresh: { label: 'Refresh', message: { type: 'refresh' } },
};

const vscode = acquireVsCodeApi();
const persisted: PersistedState = { expanded: { ...(vscode.getState()?.expanded ?? {}) } };
let renderedJson = '';
let searchTimer: number | undefined;
let lastPostedQuery = '';
let lastPostedSeq = 0;
let groupNodes = new Map<string, GroupNode>();
let cardNodes = new Map<string, CardNode>();

const app = document.getElementById('app') as HTMLElement;

const tabs = element('div', 'tabs');
tabs.setAttribute('role', 'tablist');
tabs.setAttribute('aria-label', 'Scope');
const tabButtons = new Map<Scope, HTMLButtonElement>();
for (const scope of SCOPES) {
  const button = element('button', 'tab', scopeLabel(scope));
  button.type = 'button';
  button.setAttribute('role', 'tab');
  button.addEventListener('click', () => post({ type: 'setScope', scope }));
  tabButtons.set(scope, button);
  tabs.append(button);
}

const searchInput = element('input', 'search-input');
searchInput.type = 'text';
searchInput.placeholder = 'Search sessions';
searchInput.maxLength = MAX_QUERY_LENGTH;
searchInput.spellcheck = false;
searchInput.setAttribute('aria-label', 'Search sessions');
const clearButton = iconButton('close', 'Clear search');
const searchBox = element('div', 'search');
searchBox.append(icon('search', 'search-icon'), searchInput, clearButton);

const scanRow = element('div', 'scan');
const noticesBox = element('div', 'notices');
const countLabel = element('span', 'count');
const sortSelect = element('select', 'sort');
sortSelect.setAttribute('aria-label', 'Sort sessions');
for (const sort of SORT_KEYS) {
  const option = element('option', undefined, sortLabel(sort));
  option.value = sort;
  sortSelect.append(option);
}
const summaryRow = element('div', 'summary');
summaryRow.append(countLabel, sortSelect);
const list = element('div', 'list');

app.append(tabs, searchBox, scanRow, noticesBox, summaryRow, list);

searchInput.addEventListener('input', () => {
  updateClearButton();
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => postQuery(searchInput.value), SEARCH_DELAY_MS);
});
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && searchInput.value) {
    event.preventDefault();
    clearSearch();
  }
});
clearButton.addEventListener('click', () => {
  clearSearch();
  searchInput.focus();
});
sortSelect.addEventListener('change', () => post({ type: 'setSort', sort: sortSelect.value as SortKey }));

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === 'state') {
    render(message.state);
  } else if (message.type === 'focusSearch') {
    searchInput.focus();
    searchInput.select();
  }
});

window.setInterval(updateClocks, CLOCK_INTERVAL_MS);

updateClearButton();
post({ type: 'ready' });

function render(state: ViewState): void {
  const json = JSON.stringify(state);
  if (json === renderedJson) {
    return;
  }
  renderedJson = json;

  for (const [scope, button] of tabButtons) {
    const selected = scope === state.scope;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-selected', String(selected));
  }
  syncSearchInput(state.query, state.querySeq);
  sortSelect.value = state.sort;

  renderScan(state);
  noticesBox.replaceChildren(...state.notices.map(renderNotice));
  const count = state.query ? `${state.visibleCount} of ${state.inScopeCount}` : String(state.visibleCount);
  countLabel.textContent = `${count} ${state.inScopeCount === 1 ? 'session' : 'sessions'}`;
  summaryRow.hidden = state.scan === undefined && state.groups.length === 0;

  const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.focusKey;
  syncChildren(list, state.groups.length > 0 ? renderGroups(state) : renderEmpty(state));
  if (focusKey && document.activeElement === document.body) {
    list.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
  }
  updateClocks();
}

/**
 * Echoes of queries older than the last one posted are ignored. A newer sequence (a reloaded webview) or a different
 * query at the same sequence (the Clear Search command) is a host-side change and overwrites the box.
 */
function syncSearchInput(query: string, seq: number): void {
  if (seq < lastPostedSeq || (seq === lastPostedSeq && query === lastPostedQuery.trim())) {
    return;
  }
  window.clearTimeout(searchTimer);
  lastPostedQuery = query;
  lastPostedSeq = seq;
  searchInput.value = query;
  updateClearButton();
}

function renderScan(state: ViewState): void {
  scanRow.replaceChildren();
  if (state.indexing) {
    scanRow.append(icon('sync', 'spin'), element('span', 'scan-text', 'Indexing…'));
  } else if (state.scan) {
    const time = element('span', 'scan-time');
    time.dataset.iso = state.scan.finishedAt;
    scanRow.append(icon('check'), element('span', 'scan-text', `Scanned ${countOf(state.scan.files, 'file')}`), time);
  }
  scanRow.hidden = scanRow.childElementCount === 0;
}

function renderNotice(text: string): HTMLElement {
  const notice = element('div', 'notice');
  notice.append(icon('warning', 'notice-icon'), element('span', undefined, text));
  return notice;
}

function renderEmpty(state: ViewState): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  if (state.emptyMessage) {
    nodes.push(element('p', 'empty', state.emptyMessage));
  }
  if (state.emptyActions.length > 0) {
    const actions = element('div', 'empty-actions');
    actions.append(...state.emptyActions.map((action) => textButton(EMPTY_ACTIONS[action].label, EMPTY_ACTIONS[action].message)));
    nodes.push(actions);
  }
  return nodes;
}

/**
 * Groups and unchanged cards keep their DOM nodes, so a refresh does not disturb focus or selection. Outside a search,
 * expansion follows the remembered choice or "first group open"; during a search, manual toggles last until it ends.
 */
function renderGroups(state: ViewState): HTMLElement[] {
  const searching = state.query.length > 0;
  const nextGroups = new Map<string, GroupNode>();
  const nextCards = new Map<string, CardNode>();
  const sections = state.groups.map((group, index) => {
    const existing = groupNodes.get(group.key);
    const node = existing ?? createGroup(group.key);
    if (!searching) {
      node.open = persisted.expanded[group.key] ?? index === 0;
    } else if (!existing || !node.searching) {
      node.open = true;
    }
    node.searching = searching;
    updateGroup(node, group, nextCards);
    nextGroups.set(group.key, node);
    return node.section;
  });
  groupNodes = nextGroups;
  cardNodes = nextCards;
  return sections;
}

function createGroup(key: string): GroupNode {
  const section = element('section', 'group');
  const header = element('button', 'group-header');
  header.type = 'button';
  header.dataset.focusKey = `group:${key}`;
  const label = element('span', 'group-label');
  const badge = element('span', 'badge');
  header.append(icon('chevron', 'chevron'), label, badge);
  const body = element('div', 'group-body');
  section.append(header, body);
  const node: GroupNode = { key, section, header, label, badge, body, searching: false, open: false };
  header.addEventListener('click', () => {
    node.open = !node.open;
    if (!node.searching) {
      persisted.expanded[key] = node.open;
      vscode.setState(persisted);
    }
    applyOpen(node);
  });
  return node;
}

function updateGroup(node: GroupNode, group: GroupView, nextCards: Map<string, CardNode>): void {
  if (group.path) {
    node.header.title = group.path;
  } else {
    node.header.removeAttribute('title');
  }
  node.label.textContent = group.label;
  node.badge.textContent = String(group.cards.length);
  applyOpen(node);
  syncChildren(
    node.body,
    group.cards.map((card) => {
      const json = JSON.stringify(card);
      const existing = cardNodes.get(card.key);
      const cardNode = existing?.json === json ? existing : { json, node: renderCard(card) };
      nextCards.set(card.key, cardNode);
      return cardNode.node;
    }),
  );
}

function applyOpen(node: GroupNode): void {
  node.section.classList.toggle('collapsed', !node.open);
  node.header.setAttribute('aria-expanded', String(node.open));
  node.body.hidden = !node.open;
}

function renderCard(card: CardView): HTMLElement {
  const node = element('div', `card agent-${card.agent}`);
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.setAttribute('aria-label', `Resume ${card.title}`);
  node.dataset.focusKey = `card:${card.key}`;

  const title = element('span', 'card-title', card.title);
  title.title = card.title;
  const more = iconButton('more', 'More actions');
  more.dataset.focusKey = `more:${card.key}`;
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    post({ type: 'showActions', key: card.key });
  });
  const head = element('div', 'card-head');
  head.append(title, more);
  node.append(head);

  if (card.lastReply) {
    const reply = element('div', 'card-reply');
    reply.append(element('span', 'reply-label', 'Agent: '), document.createTextNode(card.lastReply));
    node.append(reply);
  }

  const agent = element('span', 'agent');
  agent.append(icon(card.agent, 'agent-icon'), document.createTextNode(agentLabel(card.agent)));
  const meta = element('div', 'card-meta');
  meta.append(agent, element('span', undefined, countOf(card.messageCount, 'msg')));
  if (card.subagentCount > 0) {
    meta.append(element('span', undefined, countOf(card.subagentCount, 'subagent')));
  }
  const time = element('span');
  time.dataset.iso = card.updatedAt ?? '';
  if (card.updatedAt) {
    time.title = new Date(card.updatedAt).toLocaleString();
  }
  meta.append(time);
  if (card.model) {
    meta.append(element('span', 'model', card.model));
  }
  node.append(meta);

  if (card.branch || !card.interactive) {
    const tags = element('div', 'card-tags');
    if (card.branch) {
      const branch = element('span', 'tag tag-branch');
      branch.title = card.branch;
      branch.append(icon('branch'), element('span', 'tag-text', card.branch));
      tags.append(branch);
    }
    if (!card.interactive) {
      tags.append(element('span', 'tag', 'non-interactive'));
    }
    node.append(tags);
  }

  node.addEventListener('click', () => post({ type: 'open', key: card.key }));
  node.addEventListener('keydown', (event) => {
    if (event.target === node && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      post({ type: 'open', key: card.key });
    }
  });
  return node;
}

/** Removes stale children first, then inserts in order, so nodes already in place are not moved. */
function syncChildren(parent: HTMLElement, desired: readonly HTMLElement[]): void {
  const keep = new Set<Node>(desired);
  for (const child of [...parent.childNodes]) {
    if (!keep.has(child)) {
      child.remove();
    }
  }
  desired.forEach((node, index) => {
    if (parent.childNodes[index] !== node) {
      parent.insertBefore(node, parent.childNodes[index] ?? null);
    }
  });
}

function updateClocks(): void {
  const now = Date.now();
  for (const node of document.querySelectorAll<HTMLElement>('[data-iso]')) {
    node.textContent = relativeTime(node.dataset.iso || undefined, now);
  }
}

function postQuery(value: string): void {
  lastPostedQuery = value;
  lastPostedSeq++;
  post({ type: 'setQuery', query: value, seq: lastPostedSeq });
}

function clearSearch(): void {
  window.clearTimeout(searchTimer);
  searchInput.value = '';
  updateClearButton();
  postQuery('');
}

function updateClearButton(): void {
  clearButton.hidden = searchInput.value.length === 0;
}

function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function iconButton(name: IconName, label: string): HTMLButtonElement {
  const button = element('button', 'icon-button');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon(name));
  return button;
}

function textButton(label: string, message: WebviewMessage): HTMLButtonElement {
  const button = element('button', 'text-button', label);
  button.type = 'button';
  button.addEventListener('click', () => post(message));
  return button;
}

function icon(name: IconName, className?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon', `icon-${name}`);
  if (className) {
    svg.classList.add(className);
  }
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
