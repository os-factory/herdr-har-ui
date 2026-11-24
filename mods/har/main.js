// HAR for herdr: projects, agent slots, their herdr agents, usage and the verification pipeline.
// One mod, five roles chosen by props.view:
//   "tree"     – sidebar: projects with their slots under each, search, compact/detailed (also the data poller)
//   "settings" – popup: slot view, agent CLI, free slots
//   "detail"   – right panel: the selected slot, or the project overview (usage, pipeline health, lines, work)
//   "status"   – bottom bar
//   "free"     – dialog: every slot is taken, pick one to free for a new discussion
// Data: `har env status|runs --json`, `har line status --json`, .har/ records, git, gh, Mission Control (OTel usage).

import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input } from "gpui-base";
import { home, props, theme, run, notify, checking, openOverlay, closeOverlay, pickFolder, knownAgents, settings, nextCommand, keys, layout, window as appWindow } from "herdr";
import * as H from "./data.js";
import { layoutLanes } from "./lanes.js";

const ICON = (n) => `mods/har/icons/${n}.svg`;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const POLL_MS = 10000;
const SPACES_KEY = "__open-spaces__";   // its open/closed state lives with the projects' (har.expanded)
const mono = () => settings().font_family ?? "JetBrains Mono";   // the terminal font
const ROW = 24, LANE = 12, LANE_PAD = 6;   // the worktree graph: row height, lane width, left padding
const CLEAR = "#00000000";
const NOT_AGENT = /browser/i;   // programs herdr lists next to agents that can't take a prompt
// Mission Control's sections in their default order; dragging a section's title saves another (Settings key sectionOrder).
const SECTIONS = {
  overview: ["usage", "pipeline", "lines", "work"],
  slot: ["pipeline", "usage", "readiness", "git", "hints", "worktree", "previews", "agents", "convs", "runs"],
};
function sectionOrder(view) {
  const saved = (H.setting("sectionOrder") ?? {})[view] ?? [], all = SECTIONS[view];
  return [...saved.filter((k) => all.includes(k)), ...all.filter((k) => !saved.includes(k))];
}

// The HAR panel is the "har-panel" child of the right panel's stack, next to Files and Changes
// (the tab row's Mission Control | Files | Changes | Browser buttons, mods/har-tabs).
function layoutNode(n, id) {
  if (n?.id === id) return n;
  for (const c of n?.children ?? []) { const f = layoutNode(c, id); if (f) return f; }
  return null;
}
function showHarPanel() {
  run("layout.select", { stack: "panel-body", child: "har-panel" });
  run("layout.show", { id: "panel" });
}
function toggleHarPanel() {
  const L = layout(), panel = layoutNode(L, "panel"), body = layoutNode(L, "panel-body");
  if (panel && !panel.hidden && body?.active === "har-panel") run("layout.hide", { id: "panel" });
  else showHarPanel();
}

function statusColor(t, s) {
  return { blocked: t.blocked, done: t.done, working: t.working, idle: t.idle, pass: t.ansi2, fail: t.ansi1, running: t.working, skipped: t.dim }[s] ?? t.dim;
}
function verdictColor(t, v) { return { free: t.dim, safe: t.ansi2, caution: t.blocked, keep: t.ansi1 }[v] ?? t.dim; }
const VERDICT = { free: "free", safe: "safe to free", caution: "check first", keep: "keep" };

export default class Har extends View {
  init(_props, cx) {
    this.view = props()?.view ?? "tree";
    this.cx = cx;
    this.convShown = {};       // repo → conversations shown; reset when the project is collapsed
    this.loading = false;
    this.live = null;          // live verify parse for the selected slot (detail view)
    this.agentList = [];       // installed coding agents (knownAgents)
    if (checking()) return;
    if (this.view === "tree" || this.view === "free" || this.view === "settings") this.loadAgents(cx);
    if (this.view === "tree") {
      const seed = props()?.repos ?? [];
      if (!H.repos().length && seed.length) H.setRepos(H.repos(seed));
      // first run without a seed: start from the harnesses HAR already knows (~/.har/repos.json)
      if (!H.repos().length) cx.spawn(async (cx) => {
        const known = await H.knownRepos().catch(() => []);
        if (known.length && !H.repos().length) { H.setRepos(known.slice(0, 8)); for (const r of H.repos()) this.refresh(cx, r); }
        cx.notify();
      });
      this.busy = new Set();
      this.query = "";
      this.found = null;
      this.search = InputState.new({ placeholder: "Search repo, work unit, slot, PR, prompt…" });
      this.search.on("change", (_e, cx) => { this.query = this.search.value(); cx.notify(); });
      cx.spawn(async (cx) => { this.found = await H.discoverRepos().catch(() => []); cx.notify(); });
      for (const r of H.repos()) this.refresh(cx, r);
      cx.timer.every(POLL_MS, (cx) => this.refresh(cx, H.currentRepo()));
      cx.timer.every(30000, (cx) => { for (const r of H.repos()) if (r !== H.currentRepo()) this.refresh(cx, r); });
    }
    if (this.view === "status") {
      // herdr hands each "har.<command>" to every copy waiting on nextCommand(), so exactly one
      // view listens: the status bar, which is always shown (the right panel can be hidden).
      cx.spawn(async (cx) => { for (;;) { this.command(await nextCommand(), cx); cx.notify(); } });
    }
    if (this.view === "detail") {
      H.applySpacing().catch(() => {});   // the layout follows Settings → Spacing
      H.hasBrowser().catch(() => {});
      H.hasChat().catch(() => {});
      cx.timer.every(1500, (cx) => this.pollLive(cx));
      // key commands ("alt-2": "har.slot-2", "alt-v": "har.verify-full", …) are handled by the status bar
    }
    if (this.view === "git") {
      // props: { mode: "branch" | "commit" | "discard", workDir, branch, hash?, short?, file?, st?, staged? }
      const p = props() ?? {};
      this.gitError = null; this.gitBusy = false; this.stageAll = !(p.staged > 0);
      this.gitInput = InputState.new({ placeholder: p.mode === "commit" ? "Commit message" : "new-branch-name" });
      this.gitInput.on("change", (_e, cx) => { this.gitError = null; cx.notify(); });
      this.gitInput.on("submit", (_e, cx) => { this.gitGo(cx); });
      this.gitInput.focus();
      cx.timer.after(300, () => this.gitInput?.focus());
      this.handle = cx.focus_handle();
      if (p.mode === "discard") this.handle.focus();
    }
    if (this.view === "settings") {
      H.hasBrowser().then(() => cx.notify()).catch(() => {});
      H.hasChat().then(() => cx.notify()).catch(() => {});
      const mk = (key, placeholder) => {
        const st = InputState.new({ value: H.setting(key) ?? "", placeholder });
        st.on("submit", (_e, cx) => { this.savePaths(); cx.notify(); });
        return st;
      };
      this.harInput = mk("harPath", "found automatically — or e.g. ~/.volta/bin/har");
      this.nodeInput = mk("nodePath", "optional — node used to run har");
      this.saved = false;
    }
    if (this.view === "release") {
      const snap = H.snapshot(props().repo);
      this.picks = new Set(H.freeable(snap ?? { slots: [] }).map((s) => s.id));
      this.freeMode = "teardown";
      this.armed = false;
      this.handle = cx.focus_handle();
      this.handle.focus();
    }
    if (this.view === "free") {
      const p = props();
      const snap = H.snapshot(p.repo);
      const ranked = (snap?.slots ?? []).map((s) => ({ s, f: H.slotFacts(snap, s) }))
        .sort((a, b) => rank(a.f.verdict) - rank(b.f.verdict) || new Date(a.s.lastRunAt ?? a.s.since ?? 0) - new Date(b.s.lastRunAt ?? b.s.since ?? 0));
      this.pick = ranked.find((x) => x.f.verdict !== "keep")?.s.id ?? null;
      this.freeMode = "teardown";
      this.armed = false;
      this.handle = cx.focus_handle();
      const field = (placeholder) => { const st = InputState.new({ placeholder }); st.on("submit", (_e, cx) => { this.submitFree?.(); cx.notify(); }); return st; };
      this.workIn = field("work unit id, e.g. FE-2071 (optional)");
      this.titleIn = field("title (optional)");
      this.msgIn = field("first message for the agent (optional)");
      this.workIn.focus();
      cx.timer.after(400, () => this.workIn.focus());
    }
  }

  command(c, cx) {
    const repo = H.currentRepo(), snap = repo ? H.snapshot(repo) : null;
    const slot = snap?.slots.find((s) => s.id === H.currentSlot());
    const m = /^slot-(\d+)$/.exec(c);
    if (m) return H.selectSlot(Number(m[1]));
    if (c === "overview") return H.selectSlot(null);
    if (c === "refresh") return H.bump();
    if (c === "next-repo") { const all = H.repos(); return H.selectRepo(all[(all.indexOf(repo) + 1) % all.length]); }
    if (c === "new") return this.newDiscussion(repo, cx);
    if (c === "chat") return repo && this.chatInRepo(repo);
    if (c === "free") return repo && this.freeMerged(repo);
    if (c === "settings") return openSettings();
    if (c === "toggle-panel") return toggleHarPanel();
    if (c === "find-tools") return H.resetBins();   // look for har/node/gh again
    if (c === "toggle-view") return H.setSetting("slotView", H.setting("slotView") === "compact" ? "detailed" : "compact");
    if (c === "choose") return repo && openOverlay({ mod: "har", kind: "dialog", width: 640, height: 0.82, props: { view: "free", repo } });
    if (!slot?.active) return;
    if (c === "verify" || c === "verify-full") this.verify(repo, slot, c === "verify-full");
    if (c === "open") this.openSpace(repo, slot);
    if (c === "agent") this.startAgent(repo, slot);
  }

  // ---- data ----------------------------------------------------------------
  refresh(cx, repo = H.currentRepo()) {
    if (!repo || this.busy?.has(repo)) return;
    this.busy?.add(repo);
    if (repo === H.currentRepo()) { this.loadedTick = H.tick(); this.loadedRepo = repo; }
    cx.spawn(async (cx) => {
      try { H.store(repo, await H.load(repo)); if (this.view === "tree") H.syncNames(repo, H.snapshot(repo)); }
      catch (e) { H.store(repo, { ...(H.snapshot(repo) ?? { slots: [], runs: [], stages: [] }), at: Date.now(), error: String(e) }); }
      finally { this.busy?.delete(repo); cx.notify(); }
    });
  }

  loadAgents(cx) {
    cx.spawn(async (cx) => {
      const list = await knownAgents().catch(() => []);
      // herdr's list also holds programs added as "agents" that are not coding CLIs (e.g. herdr-web-browser)
      this.agentList = list.filter((a) => a.installed && a.run?.length && !NOT_AGENT.test(`${a.key} ${a.name} ${a.run[0]}`));
      if (!this.agentList.some((a) => a.key === H.agentChoice()) && this.agentList[0]) H.setAgentChoice(this.agentList[0].key);
      cx.notify();
    });
  }

  summarizeAll(cx) {
    if (this.summarizing) return;
    this.summarizing = true;
    cx.spawn(async (cx) => {
      try { for (const r of H.repos()) { H.storeSummary(r, await H.summarize(r)); cx.notify(); } }
      finally { this.summarizing = false; }
    });
  }

  pollLive(cx) {
    const repo = H.currentRepo(), id = H.currentSlot();
    const vt = repo && id != null ? H.verifyTerminal(repo, id) : null;
    if (!vt) { if (this.live) { this.live = null; H.setLive(null); cx.notify(); } return; }
    if (this.live?.final && this.live.terminal === vt.terminal) return;
    cx.spawn(async (cx) => {
      const parsed = await H.readLiveVerify(vt.terminal).catch(() => null);
      if (!parsed) return;
      const wasRunning = this.live?.running;
      this.live = { ...parsed, terminal: vt.terminal, final: parsed.stages.length > 0 && !parsed.running };
      H.setLive({ repo, slot: id, terminal: vt.terminal, running: parsed.running, stages: parsed.stages });
      if (wasRunning && !parsed.running) H.bump();
      cx.notify();
    });
  }

  // ---- actions ---------------------------------------------------------------
  tab(name, argv, folder, opts = {}) {
    run("tab.new", { name, folder, argv: H.withPath(argv), ...(opts.space ? { space: opts.space } : {}), focus: opts.focus ?? true });
  }

  agent() { return this.agentList.find((a) => a.key === H.agentChoice()) ?? this.agentList[0] ?? { key: "claude", name: "Claude Code", run: ["claude"] }; }

  /** Launches slot `id` (freeing it first when `free` is "teardown"/"complete") in its own space, then starts the agent there. */
  launchWithAgent(repo, id, free = "", agentKey = H.agentChoice(), agentList = this.agentList, opts = {}) {
    const agent = agentList.find((a) => a.key === agentKey) ?? { name: agentKey, run: [agentKey] };
    const work = (opts.work ?? "").trim(), title = (opts.title ?? "").trim(), message = (opts.message ?? "").trim();
    run("space.new", {
      name: H.slotLabel(repo, { id, work: work || null }), folder: repo,
      // claude / codex take the first message as their prompt argument
      argv: H.withPath(["bash", H.launchScript(), repo, String(id), free, work, title, "--", ...agent.run, ...(message ? [message] : [])]),
    });
    H.selectSlot(id);
  }

  /** Chat without a slot: the agent runs in the repo's own checkout, not a worktree. Each chat is a tab in the
   *  repo's "· chat" space. A shell stays open in the repo when the agent exits. */
  chatInRepo(repo, agentKey = H.agentChoice(), agentList = this.agentList, message = "") {
    const agent = agentList.find((a) => a.key === agentKey) ?? this.agent();
    const argv = H.withPath(["bash", "-c", '"$@"; exec "${SHELL:-bash}"', "chat", ...agent.run, ...(message ? [message] : [])]);
    const sp = H.chatSpace(repo);
    if (sp) run("tab.new", { space: sp.id, folder: repo, argv, name: agent.name, focus: true });
    else run("space.new", { name: H.chatLabel(repo), folder: repo, argv });
  }

  /** New discussion: first free slot, or ask which one to free. */
  newDiscussion(repo, cx) {
    const snap = repo ? H.snapshot(repo) : null;
    if (!snap) return;
    const free = snap.slots.find((s) => !s.active);
    if (free && H.setting("newMode") === "quick") return this.launchWithAgent(repo, free.id);
    openOverlay({ mod: "har", kind: "dialog", width: 640, height: 0.82, props: { view: "free", repo } });
  }

  verify(repo, slot, full) {
    const old = H.verifyTerminal(repo, slot.id);
    if (old) run("tab.close", { id: old.tab, confirmed: true });
    const space = H.slotSpace(slot, repo);
    this.live = null;
    this.tab(H.verifyTabName(repo, slot.id), ["har", "env", "verify", String(slot.id), ...(full ? ["--full"] : []), "--repo", repo], repo,
      { space: space?.id, focus: false });
    H.selectSlot(slot.id);
  }

  openSpace(repo, slot) {
    const sp = H.slotSpace(slot, repo);
    if (sp) return run("space.select", { id: sp.id });
    if (!slot.workDir) return;
    run("space.new", { name: `${H.base(repo)}#${slot.id}${slot.work ? ` · ${slot.work}` : ""}`, folder: slot.workDir });
  }

  /** Clicking an open space does what clicking its owner in the tree does: a slot's space opens that slot
   *  (Mission Control shows it, its agent is focused), a project's chat space selects the project. */
  openOwnedSpace(sp, own) {
    if (own?.slot) return this.openSlot(own.repo, own.slot);
    if (own) { H.selectRepo(own.repo); H.selectSlot(null); showHarPanel(); }
    run("space.select", { id: sp.id });
  }

  /** Clicking a slot: its agent if one is running there, else (Settings → Slot click → Resume) its most recent
   *  conversation, resumed in the slot's space. A slot with no conversation shows (or opens) its space. */
  openSlot(repo, s) {
    H.selectRepo(repo); H.selectSlot(s.id); showHarPanel();
    if (!s.active) return;
    const live = H.slotAgents(s);
    if (live.length) return run("agent.focus", { terminal: (live.find((a) => a.status === "blocked") ?? live[0]).address });
    if (H.setting("slotClick") !== "resume") return this.openSpace(repo, s);
    // the list may not be read yet on a first click: wait for it rather than miss the conversation
    H.slotConversations(repo, s).then((list) => {
      if (list[0]) this.resumeInSlot(repo, s, list[0]);
      else this.openSpace(repo, s);
      this.cx?.notify();
    }).catch(() => this.openSpace(repo, s));
  }

  /** Resumes one of a slot's conversations: focuses the tab already running it, else a new tab in the slot's
   *  space (or a new space) started in the folder the conversation ran in. A conversation still open in another
   *  app (Claude Desktop, a terminal outside herdr) isn't resumed a second time. */
  resumeInSlot(repo, s, c) {
    const name = this.convTabName(c);
    const sp = H.slotSpace(s, repo);
    if (this.focusConvTab(sp, name)) return;
    if (c.live) {
      const here = H.slotAgents(s);
      if (here.length && c.liveIn !== "claude-desktop") return run("agent.focus", { terminal: here[0].address });
      this.openSpace(repo, s);
      return notify({ title: `"${c.title}" is open in ${c.liveIn === "claude-desktop" ? "Claude Desktop" : "another terminal"}`,
        body: "Continue it there, or close it there and click the slot again to resume it here.", level: "info", timeout: 8000 });
    }
    const argv = this.resumeArgv(c), folder = c.cwd || s.workDir;
    if (sp) run("tab.new", { space: sp.id, folder, argv, name, focus: true });
    else run("space.new", { name: H.slotLabel(repo, s), folder, argv });
  }

  convTabName(c) { return c.title.length > 28 ? `${c.title.slice(0, 27)}…` : c.title; }

  /** A tab of this space already running this conversation (same name, an agent still in it): focus it rather
   *  than resume the conversation a second time. */
  focusConvTab(sp, name) {
    const tab = sp?.tabs.find((tb) => tb.name === name);
    const agent = tab && H.agentsInTab(tab.id)[0];
    if (!agent) return false;
    run("space.select", { id: sp.id });
    run("agent.focus", { terminal: agent.address });
    return true;
  }

  resumeArgv(c) {
    const cmd = c.agent === "codex" ? ["codex", "resume", c.id] : ["claude", "--resume", c.id];
    return H.withPath(["bash", "-c", '"$@"; exec "${SHELL:-bash}"', "chat", ...cmd]);
  }

  /** Start agent: resumes the slot's most recent conversation when it has one; `fresh` starts a new one. */
  startAgent(repo, slot, fresh = false) {
    if (!fresh) {
      return H.slotConversations(repo, slot).then((list) => list[0] ? this.resumeInSlot(repo, slot, list[0]) : this.startAgent(repo, slot, true));
    }
    const agent = this.agent();
    const sp = H.slotSpace(slot, repo);
    if (sp) run("tab.new", { space: sp.id, folder: slot.workDir, argv: agent.run, name: agent.name });
    else run("space.new", { name: H.slotLabel(repo, slot), folder: slot.workDir, argv: agent.run });
  }

  /** Runs a hint's quick action for a slot. */
  hintAction(kind, repo, s, h) {
    const label = `${H.base(repo)}#${s.id}`;
    if (kind === "verify-full") return this.verify(repo, s, true);
    if (kind === "agent") return this.startAgent(repo, s);
    if (kind === "focus") return run("agent.focus", { terminal: h.agent });
    if (kind === "free") return this.confirm(`Free slot ${s.id}?`, `Runs har env teardown ${s.id}: stops its services and frees the slot. Branch ${s.branch ?? ""} is kept.`,
      `teardown · ${label}`, ["har", "env", "teardown", String(s.id), "--repo", repo], repo);
    if (kind === "push") return this.confirm(`Push slot ${s.id}?`, `Runs git push in ${H.tilde(s.workDir)} (branch ${s.branch ?? "HEAD"}).`,
      `push · ${label}`, ["sh", "-c", 'git push -u origin HEAD; echo; exec "${SHELL:-bash}" -l'], s.workDir);
    if (kind === "push-pr") return this.confirm(`Push slot ${s.id} and open a PR?`,
      `Runs git push -u origin HEAD, then gh pr create --fill in ${H.tilde(s.workDir)}. You can edit the PR on GitHub afterwards.`,
      `PR · ${label}`, ["sh", "-c", 'git push -u origin HEAD && gh pr create --fill; echo; exec "${SHELL:-bash}" -l'], s.workDir);
  }

  /** Tears down every slot of `repo` with nothing to lose (merged or empty, clean, no busy agent). */
  /** "Free N done slots…": a dialog listing the slots with the chooser's details, the safe ones ticked. */
  freeMerged(repo) {
    openOverlay({ mod: "har", kind: "dialog", width: 640, height: 0.82, props: { view: "release", repo } });
  }

  /** Tears down (or completes) the ticked slots, one after another, in a tab that stays open on a shell. */
  releaseSlots(repo, ids, how) {
    if (!ids.length) return;
    const script = ids.map((id) => `har env ${how} ${id} --repo "$1" || echo "✗ slot ${id} was not freed"`).join("; ") + '; echo; exec "${SHELL:-bash}" -l';
    this.tab(`free slots · ${H.base(repo)}`, ["sh", "-c", script, "sh", repo], repo);
  }

  confirm(title, detail, name, argv, repo) {
    openOverlay({ mod: "confirm", kind: "dialog", width: 420, props: { title, detail, command: { name: "tab.new", args: { name, folder: repo, argv: H.withPath(argv) } } } });
  }

  addRepo(dir) {
    if (!dir) return;
    const list = H.repos();
    if (!list.includes(dir)) H.setRepos([...list, dir]);
    H.selectRepo(dir);
  }

  // ---- small parts -----------------------------------------------------------
  icon(name, color, size = 13) { return svg(ICON(name)).size(size).flex_none().text_color(color); }

  button(id, label, t, onClick, opts = {}) {
    const primary = opts.primary, danger = opts.danger;
    const fill = primary ? (danger ? t.ansi1 : t.solid) : CLEAR;
    const fg = primary ? t.solid_foreground : danger ? t.ansi1 : t.foreground;
    return h_flex().id(id).h(opts.h ?? 26).px(9).gap(5).items_center().flex_none().rounded(6).cursor_pointer().text_size(11.5)
      .border_1().border_color(primary ? fill : danger ? t.ansi1 + "88" : t.border)
      .bg(fill).text_color(fg)
      .hover((s) => s.bg(primary ? fill : t.hover).opacity(0.92))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .when(Boolean(opts.icon), (e) => e.child(this.icon(opts.icon, primary ? t.solid_foreground : danger ? t.ansi1 : t.muted, 12)))
      .child(label);
  }

  dot(color, size = 8) { return div().size(size).flex_none().rounded(size / 2).bg(color); }
  pulse(color, size = 8) { return div().size(size).flex_none().rounded(size / 2).bg(color).loop("opacity", { from: 0.35, to: 1, period: 1100 }); }

  chip(text, color, t, opts = {}) {
    const c = div().px(5).py(0.5).flex_none().rounded(4).border_1().border_color(color + "66").text_size(10).text_color(color).child(text);
    if (!opts.url) return c;
    return c.id(opts.id ?? `chip-${text}`).cursor_pointer().hover((s) => s.bg(color + "22")).tooltip(opts.url)
      .on_click((_e, cx) => { cx.stop_propagation(); H.openUrl(opts.url); });
  }

  prChip(pr, t, id) {
    if (!pr) return null;
    const c = pr.state === "MERGED" ? t.ansi5 ?? t.accent : pr.state === "CLOSED" ? t.dim : pr.isDraft ? t.muted : t.ansi2;
    return this.chip(`PR #${pr.number} ${pr.state === "OPEN" ? (pr.isDraft ? "draft" : "open") : pr.state.toLowerCase()}`, c, t, { url: pr.url, id });
  }

  section(title, t, right) {
    return h_flex().px(14).pt(14).pb(6).items_center().gap(6)
      .child(div().text_size(10.5).font_semibold().text_color(t.dim).child(title.toUpperCase()))
      .child(div().flex_1()).when(Boolean(right), (e) => e.child(right));
  }

  /** Lays out a view's sections ({key: [header, ...body]}, empty when absent) in the saved order. Drag a
   *  section by its title onto another to move it there. */
  arrange(view, blocks, t) {
    const order = sectionOrder(view);
    const shown = order.filter((k) => blocks[k]?.length);
    const drag = this.drag?.view === view ? this.drag : null;
    const from = drag ? shown.indexOf(drag.key) : -1;
    return shown.map((k, i) => {
      const [head, ...body] = blocks[k];
      const target = drag && drag.over === k && drag.key !== k;
      return v_flex().id(`sec-${view}-${k}`).relative()
        .when(Boolean(drag), (e) => e.cursor_grabbing())
        .when(drag?.key === k, (e) => e.opacity(0.5))
        .when(target, (e) => e.child(div().absolute().left(14).right(14).h(2).bg(t.accent).when(from < i, (l) => l.bottom(0)).when(from > i, (l) => l.top(0))))
        .on_mouse_move((_e, cx) => {
          if (this.drag?.view === view && this.drag.over !== k) { this.drag.over = k; cx.notify(); }
        })
        .on_mouse_up("left", (_e, cx) => {
          const d = this.drag;
          this.drag = null;
          if (d?.view === view && d.key !== k) {
            const next = order.filter((x) => x !== d.key);
            next.splice(next.indexOf(k) + (shown.indexOf(d.key) < i ? 1 : 0), 0, d.key);
            H.setSetting("sectionOrder", { ...(H.setting("sectionOrder") ?? {}), [view]: next });
          }
          cx.notify();
        })
        .child(div().when(!drag, (e) => e.cursor_grab()).on_mouse_down("left", () => { this.drag = { view, key: k, over: k }; }).child(head))
        .children(body);
    });
  }

  scroller(id, body, t) {
    return div().flex_1().min_h(0).relative()
      .child(v_flex().id(id).absolute().inset_0().overflow_y_scroll().child(body))
      .child(Scrollbar.vertical(id).absolute().inset_0());
  }

  /** The pipeline as one strip of cells: each verification stage, coloured by its last result. */
  strip(stages, results, t, h = 6) {
    const by = new Map((results ?? []).map((s) => [s.name, s]));
    return h_flex().gap(2).h(h).flex_1().min_w(0).children(stages.map((name) => {
      const r = by.get(name);
      const state = !r ? "none" : r.state ?? (r.skipped ? "skipped" : r.pass ? "pass" : "fail");
      const c = state === "none" ? t.border : statusColor(t, state);
      return div().flex_1().h_full().rounded(2).bg(c).when(state === "running", (e) => e.opacity(0.6));
    }));
  }

  agentPicker(t, idp) {
    const list = this.agentList.length ? this.agentList : [{ key: "claude", name: "Claude Code" }];
    const cur = H.agentChoice();
    return h_flex().h(26).p(2).gap(2).rounded(7).bg(t.raised).border_1().border_color(t.border).children(list.map((a) =>
      h_flex().id(`${idp}-ag-${a.key}`).h_full().px(8).items_center().rounded(5).cursor_pointer().text_size(11)
        .bg(a.key === cur ? t.background : CLEAR).text_color(a.key === cur ? t.foreground : t.muted)
        .when(a.key === cur, (e) => e.border_1().border_color(t.border))
        .hover((s) => s.text_color(t.foreground)).tooltip(`New slots start ${a.name} (${a.run?.join(" ") ?? a.key})`)
        .on_click((_e, cx) => { cx.stop_propagation(); H.setAgentChoice(a.key); cx.notify(); })
        .child(a.key)));
  }

  // ---- views -----------------------------------------------------------------
  render(cx) {
    H.frameStart();
    try { return this.renderView(cx); } finally { H.frameEnd(); }
  }

  renderView(cx) {
    const t = theme();
    if (this.view === "status") return this.renderStatus(t, cx);
    if (this.view === "detail") return this.renderDetail(t, cx);
    if (this.view === "free") return this.renderFree(t, cx);
    if (this.view === "release") return this.renderRelease(t, cx);
    if (this.view === "git") return this.renderGit(t, cx);
    if (this.view === "settings") return this.renderSettings(t, cx);
    // the poller follows repo switches and refresh requests
    if (!checking() && (H.tick() !== this.loadedTick || H.currentRepo() !== this.loadedRepo)) this.refresh(cx);
    // tools looked up again (Settings / Retry): reload every project, not just the current one
    const epoch = H.toolsEpoch();
    if (!checking() && this.toolsEpoch !== undefined && epoch !== this.toolsEpoch) for (const r of H.repos()) this.refresh(cx, r);
    this.toolsEpoch = epoch;
    return this.renderTree(t, cx);
  }

  // ---- sidebar: project tree ------------------------------------------------------
  renderTree(t, cx) {
    const mine = H.repos(), cur = H.currentRepo(), sel = H.currentSlot();
    const q = (this.query ?? "").trim().toLowerCase();
    const compact = H.setting("slotView") === "compact";
    const showFree = H.setting("showFree");

    const groups = mine.map((r) => {
      const snap = H.snapshot(r);
      const repoHit = !q || r.toLowerCase().includes(q);
      const slots = (snap?.slots ?? []).filter((s) => !q ? true : repoHit ? true : s.active && H.slotHaystack(snap, s).includes(q));
      return { r, snap, slots, show: !q || repoHit || slots.length > 0 };
    }).filter((g) => g.show);
    const others = q ? (this.found ?? []).filter((r) => !mine.includes(r) && r.toLowerCase().includes(q)) : [];

    const iconBtn = (id, icon, tip, on, active) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .bg(active ? t.selected : CLEAR).hover((s) => s.bg(t.hover)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); on(cx); cx.notify(); }).child(this.icon(icon, active ? t.foreground : t.dim, 13));

    const header = v_flex().flex_none().px(10).pt(10).pb(8).gap(8).border_b(1).border_color(t.border)
      .child(h_flex().items_center().gap(4)
        .child(this.icon("har", t.accent, 15))
        .child(div().pl(3).font_semibold().text_size(13).child("HAR"))
        .child(div().text_size(10.5).text_color(t.dim).child(H.agentChoice()))
        .child(div().flex_1())
        .child(this.busy?.has(H.currentRepo()) ? div().px(4).text_size(12).text_color(t.dim).frames(SPIN, 90) : div())
        .child(iconBtn("tv-toggle", compact ? "rows" : "list", compact ? "Detailed slots" : "Compact slots",
          () => H.setSetting("slotView", compact ? "detailed" : "compact"), false))
        .child(iconBtn("tv-settings", "settings", "HAR settings", () => openSettings(), false))
        .child(iconBtn("tv-add", "plus", "Add a project folder", (cx) => cx.spawn(async (cx) => { this.addRepo(await pickFolder({ prompt: "Add harness" })); cx.notify(); }), false)))
      .when(Boolean(this.search), (e) => e.child(Input.new(this.search).h(28).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground)));

    const tools = H.toolsInfo();
    const body = v_flex().px(6).py(6).gap(2)
      .when(Boolean(tools?.error), (e) => e.child(v_flex().m(4).p(9).gap(6).rounded(7).bg(t.ansi1 + "18").border_1().border_color(t.ansi1 + "55")
        .child(div().text_size(11).text_color(t.ansi1).child(tools.error))
        .child(h_flex().gap(6)
          .child(this.button("tools-settings", "Set har path…", t, () => openSettings(), { icon: "settings" }))
          .child(this.button("tools-retry", "Retry", t, () => H.resetBins(), { icon: "refresh" })))))
      .children(q ? [] : this.spaceRows(t))
      .children(groups.flatMap((g) => this.projectGroup(g, cur, sel, compact, showFree, q, t)))
      .when(Boolean(q) && !groups.length && !others.length, (e) => e.child(div().px(8).py(6).text_size(11.5).text_color(t.dim)
        .child(this.found ? "Nothing matches." : "Searching this machine…")))
      .when(others.length > 0, (e) => e.child(div().px(8).pt(10).pb(4).text_size(10).font_semibold().text_color(t.dim).child("OTHER HARNESSES ON THIS MACHINE"))
        .children(others.slice(0, 40).map((r) => h_flex().id(`found-${r}`).py(5).px(8).gap(8).items_center().rounded(7).cursor_pointer()
          .hover((e) => e.bg(t.hover)).tooltip(`Add ${H.tilde(r)}`)
          .on_click((_e, cx) => { this.addRepo(r); this.refresh(cx, r); cx.notify(); })
          .child(this.icon("plus", t.accent, 11))
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().text_size(12).child(H.base(r)))
            .child(div().truncate().text_size(10).text_color(t.dim).child(H.tilde(r).replace(/\/[^/]+$/, "")))))));

    return v_flex().id("har-tree").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12.5)
      .child(header).child(this.scroller("har-tree-list", body, t));
  }

  /** OPEN SPACES: every herdr space, the shown one highlighted, with the project and slot it belongs to, so you
   *  can see where a click on a slot will take you. A click acts as a click on its slot (or project) in the tree. */
  spaceRows(t) {
    const ix = H.spaceIndex(), list = ix.all;
    if (!list.length) return [];
    const owners = H.spaceOwners(ix);
    const perTab = new Map();
    for (const a of H.allAgents()) perTab.set(a.tab, (perTab.get(a.tab) ?? 0) + 1);
    const open = H.expanded(SPACES_KEY);
    const rows = [h_flex().id("sp-head").px(6).pt(4).pb(3).gap(4).items_center().rounded(6).cursor_pointer().hover((e) => e.bg(t.hover))
      .tooltip(open ? "Hide open spaces" : "Show open spaces")
      .on_click((_e, cx) => { H.toggleExpanded(SPACES_KEY); cx.notify(); })
      .child(this.icon(open ? "chevron-down" : "chevron-right", t.dim, 12))
      .child(div().text_size(10).font_semibold().text_color(t.dim).child(`OPEN SPACES · ${list.length}`))];
    if (!open) return [...rows, div().h(6)];
    for (const sp of list) {
      const own = owners.get(sp.id) ?? null;
      const whose = !own ? "not HAR" : own.slot ? `${H.base(own.repo)} #${own.slot.id}` : `${H.base(own.repo)} chat`;
      const agents = sp.tabs.reduce((n, tb) => n + (perTab.get(tb.id) ?? 0), 0);
      rows.push(h_flex().id(`sp-${sp.id}`).px(8).h(26).gap(7).items_center().rounded(7).cursor_pointer()
        .bg(sp.active ? t.selected : CLEAR).hover((e) => e.bg(sp.active ? t.selected : t.hover))
        .tooltip(`${sp.name}\n${H.tilde(sp.folder)} · ${sp.tabs.length} tab${sp.tabs.length === 1 ? "" : "s"}, ${agents} agent${agents === 1 ? "" : "s"}${own ? `\nbelongs to ${whose}` : ""}\nright-click: rename, worktree, close`)
        .on_click(() => this.openOwnedSpace(sp, own))
        // Herdr's own space menu: Rename, New / Open / Remove worktree, Close
        .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: sp.id } } }))
        .on_hover((on, cx) => { if (on) this.hoverSpace = sp.id; else if (this.hoverSpace === sp.id) this.hoverSpace = null; cx.notify(); })
        .child(sp.status === "working" ? this.pulse(statusColor(t, sp.status), 6) : this.dot(sp.status ? statusColor(t, sp.status) : t.border, 6))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(sp.active ? t.foreground : t.muted).child(sp.name))
        .child(div().flex_none().text_size(10).text_color(own ? t.muted : t.dim).child(whose))
        .child(this.hoverSpace === sp.id
          ? div().id(`sp-x-${sp.id}`).size(18).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
              .hover((e) => e.bg(t.ansi1 + "33")).tooltip("Close this space and end its terminals")
              .on_click((_e, cx) => { cx.stop_propagation(); this.hoverSpace = null; run("space.close", { id: sp.id }); })
              .child(this.icon("x", t.muted, 11))
          : div().flex_none().w(18).text_size(10).text_color(t.dim).child(String(sp.tabs.length))));
    }
    rows.push(div().h(8).border_b(1).border_color(t.border).mb(6));
    return rows;
  }

  projectGroup({ r, snap, slots }, cur, sel, compact, showFree, q, t) {
    const open = q ? true : H.expanded(r);
    const isCur = r === cur;
    const all = snap?.slots ?? [];
    const active = all.filter((s) => s.active);
    const dirs = active.map((s) => s.workDir);
    const ag = H.slotAgentsIn(dirs);
    const fail = active.filter((s) => s.lastVerify === "fail").length;
    const dotc = !snap ? t.border : snap.error ? t.ansi1 : ag.some((a) => a.status === "blocked") ? t.blocked
      : ag.some((a) => a.status === "working") ? t.working : fail ? t.ansi1 : active.length ? t.accent : t.dim;
    const head = h_flex().id(`pg-${r}`).px(6).h(28).gap(6).items_center().rounded(7).cursor_pointer()
      .bg(isCur && sel == null ? t.selected : CLEAR).hover((e) => e.bg(isCur && sel == null ? t.selected : t.hover)).tooltip(H.tilde(r))
      .on_click(() => { H.selectRepo(r); if (!H.expanded(r)) H.toggleExpanded(r); })
      .child(div().id(`pg-chev-${r}`).size(16).flex_none().flex().items_center().justify_center().cursor_pointer()
        .on_click((_e, cx) => { cx.stop_propagation(); H.toggleExpanded(r); cx.notify(); })
        .child(this.icon(open ? "chevron-down" : "chevron-right", t.dim, 12)))
      .child(ag.some((a) => a.status === "working") ? this.pulse(dotc, 7) : this.dot(dotc, 7))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().flex_none().text_size(12.5).font_semibold().text_color(isCur ? t.foreground : t.muted).child(H.base(r)))
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(H.tilde(r).replace(/\/[^/]+$/, ""))))
      .child(div().flex_none().text_size(10.5).text_color(active.length ? t.muted : t.dim).child(snap ? `${active.length}/${all.length}` : ""))
      .child(div().id(`pg-chat-${r}`).size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip(`Chat in ${H.base(r)} without a slot (${H.agentChoice()} in ${H.tilde(r)})`)
        .on_click((_e, cx) => { cx.stop_propagation(); H.selectRepo(r); this.chatInRepo(r); })
        .child(this.icon("message", t.muted, 13)))
      .child(div().id(`pg-new-${r}`).size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip(`New discussion in ${H.base(r)} (${H.agentChoice()})`)
        .on_click((_e, cx) => { cx.stop_propagation(); H.selectRepo(r); this.newDiscussion(r, cx); })
        .child(this.icon("plus", t.muted, 13)));
    if (!open) { delete this.convShown[r]; return [head]; }
    if (!snap) return [head, div().pl(30).py(3).text_size(11).text_color(t.dim).child("reading…")];
    const shown = slots.filter((s) => s.active);
    const free = all.filter((s) => !s.active);
    const rows = shown.map((s) => compact ? this.slotRow(r, snap, s, isCur && s.id === sel, t) : div().pl(14).child(this.slotCard(r, snap, s, isCur && s.id === sel, t)));
    if (showFree && !q && free.length) {
      rows.push(compact
        ? h_flex().id(`pg-free-${r}`).pl(30).pr(6).h(24).gap(6).items_center().rounded(6).cursor_pointer().hover((e) => e.bg(t.hover))
            .tooltip(`Launch slot ${free[0].id} and start ${H.agentChoice()}`).on_click(() => { H.selectRepo(r); this.launchWithAgent(r, free[0].id); })
            .child(this.dot(t.border, 6)).child(div().text_size(11).text_color(t.dim).child(`${free.length} free · ${free.map((s) => `#${s.id}`).join(" ")}`))
            .child(div().flex_1()).child(this.icon("play", t.dim, 11))
        : div().pl(14).children(free.map((s) => this.slotCard(r, snap, s, false, t))));
    }
    rows.push(...this.conversationRows(r, q, t));
    if (snap.error && !H.toolsInfo()?.error) rows.unshift(div().pl(30).text_size(10.5).text_color(t.ansi1).truncate().child(snap.error));
    return [head, v_flex().gap(compact ? 0 : 6).pb(4).children(rows)];
  }

  /** Claude Code / Codex conversations started in the project folder itself (never a slot's), newest first:
   *  CONV_PAGE of them, then "Load more". A search shows every title that matches. */
  conversationRows(r, q, t) {
    const all = H.repoConvs(r, () => this.cx?.notify());
    if (!all?.length) return [];
    const needle = (q ?? "").trim().toLowerCase();
    const list = needle ? all.filter((c) => c.title.toLowerCase().includes(needle)) : all;
    if (!list.length) return [];
    const n = this.convShown[r] ?? H.CONV_PAGE;
    const vis = needle ? list : list.slice(0, n);
    const rows = [div().pl(30).pt(4).pb(1).text_size(10).text_color(t.dim).child("CONVERSATIONS")];
    rows.push(...vis.map((c) => h_flex().id(`cv-${c.agent}-${c.id}`).pl(30).pr(6).h(24).gap(6).items_center().rounded(6).cursor_pointer()
      .hover((e) => e.bg(t.hover)).tooltip(`${c.title}\n${c.agent === "codex" ? "codex resume" : "claude --resume"} ${c.id} · in ${H.tilde(r)}`)
      .on_click(() => { H.selectRepo(r); this.resumeConversation(r, c); })
      .child(this.icon("message", c.agent === "codex" ? t.ansi4 : t.ansi3, 11))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(c.title))
      .child(div().flex_none().text_size(10).text_color(t.dim).child(H.ago(c.at)))));
    if (!needle && list.length > n) {
      const more = Math.min(H.CONV_MORE, list.length - n);
      rows.push(h_flex().id(`cv-more-${r}`).pl(30).pr(6).h(22).gap(6).items_center().rounded(6).cursor_pointer().hover((e) => e.bg(t.hover))
        .on_click((_e, cx) => { this.convShown[r] = n + H.CONV_MORE; cx.notify(); })
        .child(this.icon("chevron-down", t.dim, 11))
        .child(div().text_size(11).text_color(t.dim).child(`Load ${more} more · ${list.length - n} left`)));
    }
    return rows;
  }

  /** Reopens a conversation in the project folder, as a tab of its "· chat" space. */
  resumeConversation(repo, c) {
    const argv = this.resumeArgv(c);
    const name = this.convTabName(c);
    const sp = H.chatSpace(repo);
    if (this.focusConvTab(sp, name)) return;
    if (sp) run("tab.new", { space: sp.id, folder: repo, argv, name, focus: true });
    else run("space.new", { name: H.chatLabel(repo), folder: repo, argv });
  }

  /** Minimised slot: one line — status, #id, work unit, PR/push/dirty marks, verify, cost. */
  slotRow(repo, snap, s, selected, t) {
    const f = H.slotFacts(snap, s);
    const aState = H.worst(f.agents);
    const vt = H.verifyTerminal(repo, s.id);
    const lv = H.live();
    const running = Boolean(vt && lv && lv.repo === repo && lv.slot === s.id && lv.running);
    const last = H.lastVerify(snap, s);
    const color = aState ? statusColor(t, aState) : t.accent;
    const vColor = running ? t.working : last ? statusColor(t, last.status) : t.dim;
    return h_flex().id(`sr-${repo}-${s.id}`).pl(30).pr(6).h(26).gap(6).items_center().rounded(6).cursor_pointer()
      .bg(selected ? t.selected : CLEAR).hover((e) => e.bg(selected ? t.selected : t.hover))
      .tooltip([s.work, f.pr && `PR #${f.pr.number} ${f.pr.state.toLowerCase()}`, s.branch, f.reasons.join(" · "), ...H.hints(snap, s).map((h) => `→ ${h.text}`)].filter(Boolean).join("\n"))
      .on_click(() => this.openSlot(repo, s))
      .child(aState === "working" ? this.pulse(color, 7) : this.dot(color, 7))
      .child(div().w(18).flex_none().text_size(11).text_color(t.muted).child(`#${s.id}`))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(selected ? t.foreground : t.muted)
        .child(s.work ?? (f.agents[0]?.title || (s.branch ?? "").replace(/^.*-har-agent-/, "agent-"))))
      .when(aState === "blocked", (e) => e.child(div().text_size(10).text_color(t.blocked).child("needs you")))
      .when(Boolean(f.pr), (e) => e.child(div().text_size(10).text_color(f.pr.state === "MERGED" ? t.ansi5 ?? t.accent : f.pr.state === "OPEN" ? t.ansi2 : t.dim).child(`#${f.pr.number}`)))
      .when(f.unpushed > 0, (e) => e.child(div().text_size(10).text_color(t.blocked).tooltip(`${f.unpushed} unpushed`).child(`↑${f.unpushed}`)))
      .when(f.dirty, (e) => e.child(div().text_size(10).text_color(t.blocked).child("●")))
      .when(Boolean(s.stale), (e) => e.child(div().text_size(10).text_color(t.blocked).child("stale")))
      .child(running ? div().w(10).text_size(10.5).text_color(t.working).frames(SPIN, 90)
        : last ? this.icon(last.status === "pass" ? "check" : "fail", vColor, 11) : div().w(11));
  }

  slotCard(repo, snap, s, selected, t) {
    const vt = H.verifyTerminal(repo, s.id);
    const last = H.lastVerify(snap, s);
    const lv = H.live();
    const live = vt && lv && lv.repo === repo && lv.slot === s.id && lv.terminal === vt.terminal ? lv : null;
    const card = v_flex().id(`slot-${s.id}`).p(9).gap(5).rounded(8).cursor_pointer()
      .bg(selected ? t.selected : t.surface).border_1().border_color(selected ? t.accent : t.border)
      .hover((e) => e.border_color(t.input))
      .on_click(() => this.openSlot(repo, s));

    if (!s.active) {
      return card.child(h_flex().items_center().gap(7)
        .child(this.dot(t.border))
        .child(div().text_color(t.muted).child(`Slot ${s.id}`))
        .child(div().text_size(11).text_color(t.dim).child("free"))
        .child(div().flex_1())
        .child(this.button(`launch-${s.id}`, `Launch · ${H.agentChoice()}`, t, () => this.launchWithAgent(repo, s.id), { icon: "play" })
          .tooltip(`har env launch ${s.id}, then ${this.agent().run?.join(" ") ?? H.agentChoice()} in the new worktree`)));
    }

    const f = H.slotFacts(snap, s);
    const aState = H.worst(f.agents);
    const color = aState ? statusColor(t, aState) : t.accent;
    return card
      .child(h_flex().items_center().gap(7)
        .child(aState === "working" ? this.pulse(color) : this.dot(color))
        .child(div().font_semibold().child(`Slot ${s.id}`))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(s.work ?? ""))
        .when(f.agents.length > 0, (e) => e.child(div().text_size(10.5).text_color(color).child(aState === "blocked" ? "needs you" : `${f.agents.length} agent${f.agents.length > 1 ? "s" : ""}`))))
      .child(h_flex().items_center().gap(5).text_size(11).text_color(t.dim)
        .child(this.icon("branch", t.dim, 11))
        .child(div().flex_1().min_w(0).truncate().child(s.branch ?? "—"))
        .when(s.ahead != null, (e) => e.child(div().child(`↑${s.ahead} ↓${s.behind}`)))
        .when(f.dirty, (e) => e.child(div().text_color(t.blocked).tooltip("Uncommitted changes").child("●")))
        .when(Boolean(s.stale), (e) => e.child(this.chip("stale", t.blocked, t))))
      .child(h_flex().items_center().gap(5).flex_wrap()
        .when(Boolean(f.pr), (e) => e.child(this.prChip(f.pr, t, `pr-${s.id}`)))
        .when(f.unpushed > 0, (e) => e.child(this.chip(`${f.unpushed} unpushed`, t.blocked, t)))
        .when(!f.pr && f.pushed && !f.unpushed, (e) => e.child(this.chip("pushed", t.muted, t)))
        .child(div().flex_1())
        .when(f.usage.sessions > 0, (e) => e.child(div().text_size(10.5).text_color(t.muted).tooltip(`${H.tokens(f.usage.tokens)} tokens · ${f.usage.sessions} session${f.usage.sessions > 1 ? "s" : ""}`)
          .child(`${H.money(f.usage.cost)} · ${H.tokens(f.usage.tokens)}`))))
      .child(h_flex().items_center().gap(7)
        .child(this.strip(snap.stages, live ? live.stages : last?.stages, t))
        .child(live?.running ? div().text_size(10.5).text_color(t.working).frames(SPIN, 90) : div())
        .child(div().flex_none().text_size(10.5).text_color(live?.running ? t.working : last ? statusColor(t, last.status) : t.dim)
          .child(live?.running ? "verifying" : last ? `${last.status} · ${H.ago(last.at)}` : "not verified")));
  }

  savePaths() {
    const clean = (v) => { v = (v ?? "").trim(); return v.startsWith("~/") ? H.home() + v.slice(1) : v; };
    H.setSetting("harPath", clean(this.harInput?.value()) || null);
    H.setSetting("nodePath", clean(this.nodeInput?.value()) || null);
    H.resetBins();
    this.saved = true;
  }

  // ---- popup: settings -------------------------------------------------------------
  renderSettings(t, cx) {
    const p = props() ?? {};
    const seg = (id, options, value, set) => h_flex().h(26).p(2).gap(2).rounded(7).bg(t.raised).border_1().border_color(t.border).children(options.map(([k, label]) =>
      h_flex().id(`${id}-${k}`).h_full().px(8).items_center().rounded(5).cursor_pointer().text_size(11)
        .bg(k === value ? t.background : CLEAR).text_color(k === value ? t.foreground : t.muted)
        .when(k === value, (e) => e.border_1().border_color(t.border))
        .on_click((_e, cx) => { set(k); cx.notify(); }).child(label)));
    const row = (label, hint, control) => v_flex().gap(5).child(h_flex().items_center().child(div().flex_1().text_size(12).child(label)).child(control))
      .when(Boolean(hint), (e) => e.child(div().text_size(10.5).text_color(t.dim).child(hint)));
    const agents = (this.agentList.length ? this.agentList : [{ key: "claude", name: "Claude Code" }]);
    const cur = this.agentList.find((a) => a.key === H.agentChoice());
    const info = H.toolsInfo();
    const toolsLine = !info ? "Looking for har, node and gh…" : info.error ? info.error
      : `har ${H.tilde(info.har)} · node ${H.tilde(info.node)}${info.gh ? ` · gh ${H.tilde(info.gh)}` : " · gh not found (no PR state)"} — found via ${info.how}`;
    return v_flex().id("har-settings").size_full().p(14).gap(14).bg(t.popover).text_color(t.foreground).text_size(12)
      .child(h_flex().items_center().child(div().flex_1().font_semibold().text_size(13).child("HAR panel")).child(div().text_size(10.5).text_color(t.dim).child("Esc")))
      .child(row("Slot view", "Compact: one line per slot. Detailed: cards with branch, PR, cost and pipeline.",
        seg("sv", [["compact", "Compact"], ["detailed", "Detailed"]], H.setting("slotView"), (k) => H.setSetting("slotView", k))))
      .child(row("Agent CLI", cur ? `New slots run: ${cur.run.join(" ")}` : "Installed coding agents found by herdr.",
        seg("ag", agents.map((a) => [a.key, a.key]), H.agentChoice(), (k) => H.setAgentChoice(k))))
      .child(row("Free slots", "Show free slots under each project.",
        seg("sf", [["on", "Show"], ["off", "Hide"]], H.setting("showFree") ? "on" : "off", (k) => H.setSetting("showFree", k === "on"))))
      .child(row("Spacing", "Gaps and corners around terminals and the right panel.",
        seg("sp", [["none", "None"], ["compact", "Compact"], ["comfortable", "Comfortable"]], H.setting("spacing"),
          (k) => { H.setSetting("spacing", k); H.applySpacing().catch(() => {}); })))
      .child(row("New discussion", "Ask: a dialog for work unit, title and first message (Enter starts). Quick: launch the first free slot right away.",
        seg("nm", [["ask", "Ask"], ["quick", "Quick"]], H.setting("newMode"), (k) => H.setSetting("newMode", k))))
      .child(row("Slot click", "Resume: clicking a slot with no agent running resumes its most recent Claude Code or Codex conversation in its worktree. Select: only shows the slot.",
        seg("sc", [["resume", "Resume"], ["select", "Select"]], H.setting("slotClick"), (k) => H.setSetting("slotClick", k))))
      .child(row("Names", "Rename herdr spaces and tabs after their slot: har-project#2 · work-unit.",
        seg("nn", [["on", "On"], ["off", "Off"]], H.setting("nameSpaces") === false ? "off" : "on", (k) => H.setSetting("nameSpaces", k === "on"))))
      .child(row("Links", H.browserInstalled() === false ? "herdr-web-browser is not installed, so links use the system browser. Install builds it with Rust (cargo) and downloads its own Chrome (~200 MB)."
          : "Preview, PR and Mission Control links open in the herdr browser beside the focused pane.",
        H.browserInstalled() === false
          ? this.button("ln-install", "Install browser", t, () => this.tab("install herdr-web-browser", ["bash", H.browserInstallScript()], home()), { icon: "play" })
          : seg("ln", [["herdr", "herdr browser"], ["system", "System browser"]], H.setting("links"), (k) => H.setSetting("links", k))))
      .child(row("Chat view", H.chatInstalled() === false
          ? "herdr-claude-chat is not installed. It shows a Claude Code terminal as a chat, swapped by ctrl-shift-j."
          : "ctrl-shift-j, or the toggle at the right of the tab row, swaps a Claude Code terminal and its chat.",
        H.chatInstalled() === false
          ? this.button("ch-install", "Install chat", t, () => this.tab("install herdr-claude-chat", ["bash", H.chatInstallScript()], home()), { icon: "play" })
          : div().text_size(11).text_color(t.dim).child("installed")))
      .child(v_flex().gap(6).pt(4).border_t(1).border_color(t.border)
        .child(div().pt(8).text_size(12).child("Tools"))
        .child(div().text_size(10.5).text_color(info?.error ? t.ansi1 : t.dim).child(toolsLine))
        .when(Boolean(this.harInput), (e) => e
          .child(div().text_size(10.5).text_color(t.dim).child("har path"))
          .child(Input.new(this.harInput).h(28).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(11.5).text_color(t.foreground))
          .child(div().text_size(10.5).text_color(t.dim).child("node path"))
          .child(Input.new(this.nodeInput).h(28).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(11.5).text_color(t.foreground))))
      .child(div().flex_1())
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(10.5).text_color(t.dim).child(this.saved ? "Saved — looking for the tools again…" : "Leave the paths empty to find them automatically."))
        .child(this.button("set-save", "Save paths", t, (cx) => { this.savePaths(); cx.notify(); }))
        .child(this.button("set-done", "Done", t, () => closeOverlay(p.overlay), { primary: true })));
  }

  // ---- dialog: free a slot -------------------------------------------------------
  /** One slot in the chooser and the free-slots dialog: verdict, reasons, branch, PR, push/dirty state, verify, agents,
   *  cost and last commit. `multi` draws a checkbox instead of a radio. */
  slotChoice(snap, { s, f }, on, t, onClick, multi = false) {
      const vc = verdictColor(t, f.verdict);
      const last = H.lastVerify(snap, s);
      const aState = H.worst(f.agents);
      return v_flex().id(`fr-${s.id}`).p(10).gap(5).rounded(8).cursor_pointer()
        .bg(on ? t.selected : t.surface).border_1().border_color(on ? t.accent : t.border).hover((e) => e.border_color(t.input))
        .on_click((_e, cx) => onClick(cx))
        .child(h_flex().items_center().gap(8)
          .child(multi
            ? div().size(14).flex_none().rounded(3).border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : CLEAR)
                .flex().items_center().justify_center().child(on ? this.icon("check", t.background, 10) : div())
            : div().size(14).flex_none().rounded(7).border_1().border_color(on ? t.accent : t.input)
                .child(on ? div().size(8).m(2).rounded(4).bg(t.accent) : div()))
          .child(div().font_semibold().child(`Slot ${s.id}`))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(s.work ?? (s.active ? "no work unit" : "")))
          .child(this.chip(VERDICT[f.verdict], vc, t)))
        .when(s.active, (e) => e
          .child(div().pl(22).text_size(11.5).text_color(vc).child(f.reasons.join(" · ")))
          .child(h_flex().pl(22).gap(6).items_center().flex_wrap().text_size(11).text_color(t.dim)
            .child(this.icon("branch", t.dim, 11)).child(div().max_w(260).truncate().child(s.branch ?? "—"))
            .when(s.ahead != null, (e) => e.child(div().child(`↑${s.ahead} ↓${s.behind}`)))
            .when(Boolean(f.pr), (e) => e.child(this.prChip(f.pr, t, `fpr-${s.id}`)))
            .child(this.chip(f.unpushed > 0 ? `${f.unpushed} unpushed` : f.pushed ? "pushed" : (s.ahead ?? 0) > 0 ? "not pushed" : "nothing to push",
              f.unpushed > 0 ? t.blocked : t.muted, t))
            .child(this.chip(f.dirty ? `${f.git?.changed ?? ""} uncommitted`.trim() : "clean", f.dirty ? t.blocked : t.muted, t))
            .when(Boolean(s.stale), (e) => e.child(this.chip(`stale · ${s.behind} behind`, t.blocked, t))))
          .child(h_flex().pl(22).gap(12).items_center().text_size(11).text_color(t.dim)
            .child(div().text_color(last ? statusColor(t, last.status) : t.dim).child(last ? `verify ${last.status}${last.full ? " --full" : ""} · ${H.ago(last.at)}` : "never verified"))
            .child(div().text_color(aState ? statusColor(t, aState) : t.dim).child(f.agents.length ? `${f.agents.length} agent${f.agents.length > 1 ? "s" : ""} ${aState}` : "no agent open"))
            .when(f.usage.sessions > 0, (e) => e.child(div().child(`${H.money(f.usage.cost)} · ${H.tokens(f.usage.tokens)} tok`)))
            .when(Boolean(s.since), (e) => e.child(div().child(`started ${H.ago(s.since)}`))))
          .when(Boolean(f.git?.subject), (e) => e.child(div().pl(22).truncate().text_size(11).text_color(t.muted).child(`last commit: ${f.git.subject}`))));
  }

  freeModeRow(key, label, hint, t) {
    return h_flex().id(`fm-${key}`).flex_1().p(8).gap(8).items_start().rounded(7).cursor_pointer()
      .border_1().border_color(this.freeMode === key ? t.accent : t.border).bg(this.freeMode === key ? t.selected : CLEAR)
      .on_click((_e, cx) => { this.freeMode = key; cx.notify(); })
      .child(div().mt(2).size(12).flex_none().rounded(6).border_1().border_color(this.freeMode === key ? t.accent : t.input)
        .child(this.freeMode === key ? div().size(6).m(2).rounded(3).bg(t.accent) : div()))
      .child(v_flex().gap(2).child(div().text_size(12).child(label)).child(div().text_size(10.5).text_color(t.dim).child(hint)));
  }

  renderRelease(t, cx) {
    const p = props() ?? {};
    const repo = p.repo, snap = H.snapshot(repo);
    const rows = (snap?.slots ?? []).filter((s) => s.active).map((s) => ({ s, f: H.slotFacts(snap, s) }))
      .sort((a, b) => rank(a.f.verdict) - rank(b.f.verdict) || a.s.id - b.s.id);
    const close = () => closeOverlay(p.overlay);
    const chosen = rows.filter((x) => this.picks.has(x.s.id));
    const risky = chosen.filter((x) => x.f.verdict === "keep" || x.f.verdict === "caution");
    const go = () => {
      if (!chosen.length) return;
      if (risky.length && !this.armed) { this.armed = true; return; }
      close();
      this.releaseSlots(repo, chosen.map((x) => x.s.id), this.freeMode);
    };
    const toggle = (id, cx) => { if (this.picks.has(id)) this.picks.delete(id); else this.picks.add(id); this.armed = false; cx.notify(); };
    const n = chosen.length;
    const verb = this.freeMode === "complete" ? "Complete" : "Tear down";
    const label = !n ? "Pick slots" : this.armed ? `Really free ${n} slot${n > 1 ? "s" : ""}?` : `${verb} ${n} slot${n > 1 ? "s" : ""}`;

    return v_flex().id("har-release").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } else if (e.key === "enter") { go(); cx.notify(); cx.stop_propagation(); } })
      .child(v_flex().flex_none().px(18).pt(16).pb(10).gap(4)
        .child(h_flex().items_center().gap(8)
          .child(div().flex_1().text_size(15).font_semibold().child(`Free slots · ${H.base(repo)}`))
          .child(div().text_size(11).text_color(t.dim).child("Esc")))
        .child(div().text_size(11.5).text_color(t.muted).child("Slots with nothing to lose are ticked: PR merged or closed, or no commits, with a clean worktree and no agent working. Branches are kept either way.")))
      .child(this.scroller("har-release-list", v_flex().px(18).pb(8).gap(6).children(rows.length
        ? rows.map((x) => this.slotChoice(snap, x, this.picks.has(x.s.id), t, (cx) => toggle(x.s.id, cx), true))
        : [div().py(20).text_color(t.dim).child("No slot is in use.")]), t))
      .child(v_flex().flex_none().px(18).pt(10).pb(16).gap(10).border_t(1).border_color(t.border)
        .child(h_flex().gap(8)
          .child(this.freeModeRow("teardown", "Teardown", "Stops the slots, keeps the branches. Always works.", t))
          .child(this.freeModeRow("complete", "Complete", "Closes each work attempt; needs a passing verify --full.", t)))
        .when(risky.length > 0, (e) => e.child(div().text_size(11.5).text_color(t.ansi1)
          .child(`⚠ ${risky.map((x) => `slot ${x.s.id}: ${x.f.reasons.join(", ")}`).join("; ")}. An agent still running there loses its session.`)))
        .child(h_flex().items_center().gap(8)
          .child(div().text_size(11.5).text_color(t.dim).child(`${n} of ${rows.length} selected`))
          .child(div().flex_1())
          .child(this.button("rl-cancel", "Cancel", t, close, { h: 30 }))
          .child(this.button("rl-go", label, t, (cx) => { go(); cx.notify(); }, { primary: true, danger: risky.length > 0, icon: "check", h: 30 }))));
  }

  renderFree(t, cx) {
    const p = props() ?? {};
    const repo = p.repo, snap = H.snapshot(repo);
    const rows = (snap?.slots ?? []).map((s) => ({ s, f: H.slotFacts(snap, s) }))
      .sort((a, b) => rank(a.f.verdict) - rank(b.f.verdict) || a.s.id - b.s.id);
    const picked = rows.find((x) => x.s.id === this.pick) ?? null;
    const close = () => closeOverlay(p.overlay);
    const go = () => {
      if (!picked) return;
      if (picked.f.verdict === "keep" && !this.armed) { this.armed = true; return; }
      close();
      this.launchWithAgent(repo, picked.s.id, picked.s.active ? this.freeMode : "", H.agentChoice(), this.agentList,
        { work: this.workIn?.value(), title: this.titleIn?.value(), message: this.msgIn?.value() });
    };
    this.submitFree = go;

    const slotRow = (x) => this.slotChoice(snap, x, x.s.id === this.pick, t, (cx) => { this.pick = x.s.id; this.armed = false; cx.notify(); });
    const mode = (key, label, hint) => this.freeModeRow(key, label, hint, t);

    const keep = picked?.f.verdict === "keep";
    const label = !picked ? "Pick a slot" : !picked.s.active ? `Launch slot ${picked.s.id} & start ${this.agent().name}`
      : this.armed ? `Really free slot ${picked.s.id}?` : `Free slot ${picked.s.id} & start ${this.agent().name}`;
    const anyFree = rows.some((x) => !x.s.active);

    return v_flex().id("har-free").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } else if (e.key === "enter") { go(); cx.notify(); cx.stop_propagation(); } })
      .child(v_flex().flex_none().px(18).pt(16).pb(10).gap(4)
        .child(h_flex().items_center().gap(8)
          .child(div().flex_1().text_size(15).font_semibold().child(anyFree ? `New discussion · ${H.base(repo)}` : `New discussion · all ${rows.length} slots of ${H.base(repo)} are taken`))
          .child(div().text_size(11).text_color(t.dim).child("Esc")))
        .child(div().text_size(11.5).text_color(t.muted).child(anyFree ? "Pick a free slot, or one to free. Slots are ranked from safest to free: merged or empty work first, unpushed or uncommitted work last."
          : "Pick the slot to free for the new discussion. Slots are ranked from safest to free: merged or empty work first, unpushed or uncommitted work last.")))
      .when(Boolean(this.workIn), (e) => e.child(v_flex().flex_none().px(18).pb(10).gap(6)
        .child(h_flex().gap(6)
          .child(Input.new(this.workIn).flex_1().h(30).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground))
          .child(Input.new(this.titleIn).flex_1().h(30).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground)))
        .child(Input.new(this.msgIn).h(30).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground))
        .child(div().text_size(10.5).text_color(t.dim).child("The work unit is bound at launch (har env launch --work-id), names the space, and is what Mission Control and the portal attribute cost to. Enter starts."))))
      .child(this.scroller("har-free-list", v_flex().px(18).pb(8).gap(6).children(rows.map(slotRow)), t))
      .child(v_flex().flex_none().px(18).pt(10).pb(16).gap(10).border_t(1).border_color(t.border)
        .when(Boolean(picked?.s.active), (e) => e.child(h_flex().gap(8)
          .child(mode("teardown", "Teardown", "Stops the slot, keeps the branch. Always works."))
          .child(mode("complete", "Complete", "Closes the work attempt; needs a passing verify --full."))))
        .when(keep, (e) => e.child(div().text_size(11.5).text_color(t.ansi1).child(`⚠ Slot ${picked.s.id}: ${picked.f.reasons.join(", ")}. The branch is kept, but an agent still running there loses its session.`)))
        .child(h_flex().items_center().gap(8)
          .child(div().text_size(11.5).text_color(t.dim).child("Agent")).child(this.agentPicker(t, "fr"))
          .child(div().flex_1())
          .child(this.button("fr-chat", "Chat in repo", t, () => {
              this.chatInRepo(repo, H.agentChoice(), this.agentList, String(this.msgIn?.value() ?? "").trim()); close();
            }, { icon: "message", h: 30 }).tooltip("Skip the slot: start the agent in the repo checkout itself"))
          .child(this.button("fr-cancel", "Cancel", t, close, { h: 30 }))
          .child(this.button("fr-go", label, t, (cx) => { go(); cx.notify(); }, { primary: true, danger: keep, icon: "play", h: 30 }))));
  }

  // ---- right panel ---------------------------------------------------------------
  renderDetail(t, cx) {
    const repo = H.currentRepo(), snap = repo ? H.snapshot(repo) : null, id = H.currentSlot();
    const slot = snap?.slots.find((s) => s.id === id) ?? null;
    const sp = H.spacing();
    const shell = (children) => v_flex().id("har-detail").size_full().min_h(0).rounded(sp.radius).overflow_hidden().bg(t.background)
      .when(!sp.divider, (e) => e.border_1().border_color(t.border)).text_color(t.foreground).text_size(12.5)
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; cx.notify(); } })
      .child(this.scroller("har-detail-scroll", v_flex().pb(14).children(children), t));
    if (!snap) return shell([div().p(14).text_color(t.dim).child("Waiting for HAR data…")]);
    if (!slot) return shell(this.overview(repo, snap, t, cx));
    return shell(this.slotDetail(repo, snap, slot, t, cx));
  }

  usageBlock(u, t, opts = {}) {
    if (!u || u.sessions === 0) return div().px(14).text_size(11.5).text_color(t.dim).child(opts.empty ?? "No OTel usage recorded yet.");
    const models = Object.entries(u.models).sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens).slice(0, 4);
    const stat = (label, value, color) => v_flex().gap(1).child(div().text_size(10).text_color(t.dim).child(label)).child(div().text_size(12.5).text_color(color ?? t.foreground).child(value));
    return v_flex().px(14).gap(8)
      .child(h_flex().gap(14).items_end().flex_wrap()
        .child(v_flex().gap(1).child(div().text_size(10).text_color(t.dim).child(opts.label ?? "Cost"))
          .child(div().text_size(20).font_semibold().child(u.unpriced && !u.cost ? "unpriced" : H.money(u.cost))))
        .child(stat("Tokens", H.tokens(u.tokens)))
        .child(stat("In / out", `${H.tokens(u.input)} / ${H.tokens(u.output)}`))
        .child(stat("Cache", H.tokens(u.cacheRead), t.muted))
        .child(stat("Sessions", String(u.sessions), t.muted)))
      .child(v_flex().gap(3).children(models.map(([m, v]) => h_flex().gap(8).items_center().text_size(11)
        .child(div().w(130).flex_none().truncate().text_color(t.muted).child(m))
        .child(div().flex_1().h(5).rounded(3).bg(t.raised).child(div().h_full().rounded(3).bg(t.accent + "aa").w(`${Math.max(2, Math.round((u.cost ? v.cost / u.cost : v.tokens / Math.max(1, u.tokens)) * 100))}%`)))
        .child(div().w(54).text_right().text_color(t.dim).child(H.money(v.cost)))
        .child(div().w(44).text_right().text_color(t.dim).child(H.tokens(v.tokens))))));
  }

  overview(repo, snap, t, cx) {
    const active = snap.slots.filter((s) => s.active);
    const ru = H.repoUsage(snap);
    const out = [
      h_flex().h(44).px(14).items_center().gap(8).border_b(1).border_color(t.border)
        .child(this.icon("har", t.accent, 15)).child(div().font_semibold().child(H.base(repo)))
        .child(this.chip(snap.profile ?? "?", t.muted, t)).child(div().flex_1())
        .child(this.button("mc", "Mission Control", t, () => H.openMissionControl(repo, null), { icon: "external" })),
      div().px(14).pt(10).text_size(11.5).text_color(t.dim).child(`${H.tilde(repo)} · ${active.length}/${snap.slots.length} slots in use`),
      (() => {
        const fr = H.freeable(snap);
        return h_flex().px(14).pt(10).gap(6).flex_wrap()
          .child(this.button("ov-new", "New discussion", t, (cx) => this.newDiscussion(repo, cx), { primary: true, icon: "plus" }))
          .child(this.button("ov-chat", "Chat in repo", t, () => this.chatInRepo(repo), { icon: "message" })
            .tooltip(`${H.agentChoice()} in ${H.tilde(repo)} itself: no slot, no worktree, no verify`))
          .when(fr.length > 0, (e) => e.child(this.button("ov-free", `Free ${fr.length} done slot${fr.length > 1 ? "s" : ""}…`, t, () => this.freeMerged(repo), { icon: "check" })
            .tooltip(fr.map((s) => `#${s.id}: ${H.slotFacts(snap, s).reasons.join(", ")}`).join("\n"))))
          .child(this.button("ov-cleanup", "Clean up stale worktrees…", t, () => this.tab(`cleanup · ${H.base(repo)}`, ["har", "env", "cleanup"], repo), { icon: "x" })
            .tooltip("har env cleanup: finds session worktrees left behind across your repos and asks before removing them"))
          .child(this.button("ov-doctor", "Doctor", t, () => this.tab(`doctor · ${H.base(repo)}`, ["har", "env", "doctor", "--repo", repo], repo), { icon: "check" })
            .tooltip("har env doctor: checks the harness contract"));
      })(),
    ];

    const blocks = { usage: [], pipeline: [], lines: [], work: [] };

    // usage
    blocks.usage.push(this.section("Usage · OTel", t, snap.usage?.error ? div().text_size(10.5).text_color(t.blocked).child(snap.usage.error) : null));
    if (!snap.usage?.error) {
      blocks.usage.push(this.usageBlock(ru.all, t, { label: "Repository total" }));
      const perSlot = active.map((s) => ({ s, u: H.slotUsage(snap, s) }));
      const max = Math.max(0.0001, ...perSlot.map((x) => x.u.cost), ru.unattributed.cost);
      blocks.usage.push(v_flex().px(14).pt(10).gap(3)
        .children(perSlot.map(({ s, u }) => h_flex().id(`us-${s.id}`).gap(8).items_center().text_size(11).cursor_pointer().on_click(() => H.selectSlot(s.id))
          .child(div().w(46).flex_none().text_color(t.muted).child(`Slot ${s.id}`))
          .child(div().flex_1().h(6).rounded(3).bg(t.raised).child(div().h_full().rounded(3).bg(t.working + "bb").w(`${u.cost ? Math.max(2, Math.round((u.cost / max) * 100)) : 0}%`)))
          .child(div().w(54).text_right().text_color(u.sessions ? t.foreground : t.dim).child(u.sessions ? H.money(u.cost) : "—"))
          .child(div().w(44).text_right().text_color(t.dim).child(u.sessions ? H.tokens(u.tokens) : ""))))
        .child(h_flex().gap(8).items_center().text_size(11).tooltip("Sessions in this repo that no slot could be matched to (e.g. run in the main checkout)")
          .child(div().w(46).flex_none().text_color(t.dim).child("Other"))
          .child(div().flex_1().h(6).rounded(3).bg(t.raised).child(div().h_full().rounded(3).bg(t.dim).w(`${ru.unattributed.cost ? Math.max(2, Math.round((ru.unattributed.cost / max) * 100)) : 0}%`)))
          .child(div().w(54).text_right().text_color(t.muted).child(H.money(ru.unattributed.cost)))
          .child(div().w(44).text_right().text_color(t.dim).child(H.tokens(ru.unattributed.tokens)))));
    }

    // pipeline health: the last verify runs as a stage × run grid
    const verifies = snap.runs.filter((r) => r.kind === "verify" && r.stages).slice(0, 16).reverse();
    const names = [...snap.stages, ...new Set(verifies.flatMap((r) => r.stages.map((x) => x.name)).filter((n) => !snap.stages.includes(n)))];
    const passN = verifies.filter((r) => r.status === "pass").length;
    blocks.pipeline.push(this.section("Pipeline health", t, verifies.length ? div().text_size(10.5).text_color(passN / verifies.length >= 0.8 ? t.ansi2 : t.blocked)
      .child(`${Math.round((passN / verifies.length) * 100)}% of last ${verifies.length} verifies pass`) : null));
    if (!verifies.length) blocks.pipeline.push(div().px(14).text_size(11.5).text_color(t.dim).child("No verify runs recorded."));
    else blocks.pipeline.push(v_flex().px(14).gap(2).children(names.map((name) => {
      const cells = verifies.map((r) => r.stages.find((x) => x.name === name) ?? null);
      const ran = cells.filter(Boolean).filter((c) => !c.skipped);
      const fails = ran.filter((c) => !c.pass).length;
      const flaky = fails > 0 && fails < ran.length;
      const ms = ran.map((c) => c.ms).filter((x) => x != null).sort((a, b) => a - b);
      const med = ms.length ? ms[Math.floor(ms.length / 2)] : null;
      const rate = ran.length ? Math.round(((ran.length - fails) / ran.length) * 100) : null;
      return h_flex().h(18).gap(8).items_center()
        .child(div().w(96).flex_none().truncate().text_size(11.5).text_color(fails ? t.foreground : t.muted).child(name))
        .child(h_flex().flex_1().min_w(0).h(10).gap(2).gap(1).children(cells.map((c, i) => div().w(3).flex_none().h_full().rounded(1)
          .bg(!c ? t.raised : c.skipped ? t.border : c.pass ? t.ansi2 + "cc" : t.ansi1))))
        .child(div().w(40).flex_none().text_right().text_size(10.5).text_color(rate == null ? t.dim : rate === 100 ? t.muted : rate >= 80 ? t.blocked : t.ansi1).child(rate == null ? "—" : `${rate}%`))
        .child(div().w(40).text_right().text_size(10.5).text_color(t.dim).child(med != null ? H.dur(med) : ""))
        .child(div().w(34).text_size(10).text_color(t.blocked).child(flaky ? "flaky" : ""));
    })).child(h_flex().pt(4).text_size(10).text_color(t.dim).child(div().flex_1().child(`← oldest · newest →`)).child(div().child("pass rate · median"))));

    // factory lines
    if (snap.lines?.length) {
      blocks.lines.push(this.section(`Factory lines · ${snap.lines.length}`, t));
      blocks.lines.push(v_flex().px(14).gap(10).children(snap.lines.map((l) => {
        const st = l.stations ?? [];
        const next = st.find((s) => !s.green);
        const green = st.filter((s) => s.green).length;
        return v_flex().gap(5)
          .child(h_flex().gap(6).items_center()
            .child(div().font_semibold().text_size(12).child(l.title ?? l.lineId))
            .child(div().flex_1())
            .child(div().text_size(10.5).text_color(green === st.length ? t.ansi2 : t.dim).child(`${green}/${st.length} stations`)))
          .child(h_flex().gap(3).children(st.map((s) => {
            const failed = (s.requiredStageIds ?? []).filter((x) => !(s.passedStageIds ?? []).includes(x) && !(s.neverRunStageIds ?? []).includes(x) && !(s.missingStageIds ?? []).includes(x));
            const c = s.green ? t.ansi2 : failed.length ? t.ansi1 : (s.missingStageIds ?? []).length ? t.blocked : t.dim;
            return h_flex().id(`st-${l.lineId}-${s.id}`).flex_1().h(20).items_center().justify_center().rounded(4)
              .bg(s.green ? t.ansi2 + "33" : CLEAR).border_1().border_color(c + (s === next ? "" : "66"))
              .text_size(10.5).text_color(c).tooltip(`${s.id} · ${s.title}${s.green ? " — green" : failed.length ? ` — failing: ${failed.join(", ")}` : " — not run yet"}`)
              .child(s.id);
          })))
          .when(Boolean(next), (e) => e.child(div().truncate().text_size(11).text_color(t.muted).child(`next: ${next.id} · ${next.title}`)));
      })));
    }

    // work units
    const units = snap.workUnits ?? [];
    blocks.work.push(this.section(`Work units · ${units.length}`, t));
    if (!units.length) blocks.work.push(div().px(14).text_size(11.5).text_color(t.dim).child("No work units bound yet (har env launch --work-id …)."));
    blocks.work.push(v_flex().px(8).gap(1).children(units.slice(0, 30).map((w) => {
      const inSlot = active.find((s) => s.work === w.id);
      const u = H.workUsage(snap, w.id);
      return h_flex().id(`wu-${w.id}`).h(36).px(6).gap(8).items_center().rounded(6).hover((e) => e.bg(t.hover))
        .when(Boolean(inSlot), (e) => e.cursor_pointer().on_click(() => H.selectSlot(inSlot.id)))
        .when(Boolean(w.url), (e) => e.tooltip(w.url))
        .child(inSlot ? this.dot(t.accent, 7) : this.dot(t.border, 7))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12).child(w.id))
          .child(div().truncate().text_size(10.5).text_color(t.dim).child(w.title ?? "")))
        .child(inSlot ? this.chip(`slot ${inSlot.id}`, t.accent, t) : div().text_size(10.5).text_color(t.dim).child(`${w.attempts.length} attempt${w.attempts.length === 1 ? "" : "s"}`))
        .child(div().w(50).text_right().text_size(11).text_color(u.sessions ? t.foreground : t.dim).child(u.sessions ? H.money(u.cost) : "—"))
        .child(div().w(52).text_right().text_size(10.5).text_color(t.dim).child(H.ago(w.lastAt)));
    })));
    return [...out, ...this.arrange("overview", blocks, t)];
  }

  slotDetail(repo, snap, s, t, cx) {
    const f = H.slotFacts(snap, s);
    const agents = f.agents;
    // Claude Code / Codex conversations that ran in this slot's worktree, newest first
    const convs = s.active ? (H.slotConvs(repo, s, () => this.cx?.notify()) ?? []) : [];
    const vt = H.verifyTerminal(repo, s.id);
    const live = vt && this.live?.terminal === vt.terminal ? this.live : null;
    const last = H.lastVerify(snap, s);
    const results = live ? live.stages : last?.stages?.map((x) => ({ ...x, state: x.skipped ? "skipped" : x.pass ? "pass" : "fail" })) ?? [];
    const byName = new Map(results.map((r) => [r.name, r]));
    const names = [...snap.stages, ...results.map((r) => r.name).filter((n) => !snap.stages.includes(n))];
    const maxMs = Math.max(1, ...results.map((r) => r.ms ?? 0));
    const runs = snap.runs.filter((r) => r.slot === s.id).slice(0, 6);
    const entries = Object.entries(s.previews ?? {});
    const unit = (snap.workUnits ?? []).find((w) => w.id === s.work);

    const header = v_flex().px(14).pt(12).pb(10).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().items_center().gap(8)
        .child(div().text_size(15).font_semibold().child(`Slot ${s.id}`))
        .child(this.chip(s.active ? "active" : "free", s.active ? t.ansi2 : t.dim, t))
        .when(Boolean(s.stale), (e) => e.child(this.chip(`stale · ${s.behind} behind`, t.blocked, t)))
        .when(s.usage === "bypass_warning", (e) => e.child(this.chip("harness bypassed", t.blocked, t)))
        .child(div().flex_1())
        .child(div().id("close-detail").cursor_pointer().tooltip("Back to overview").on_click(() => H.selectSlot(null)).child(this.icon("x", t.dim, 13))))
      .when(Boolean(s.work), (e) => e.child(v_flex().gap(1)
        .child(h_flex().gap(6).items_center().text_size(12).child(div().text_color(t.dim).child("Work unit")).child(div().font_semibold().child(s.work)))
        .when(Boolean(unit?.title), (e) => e.child(div().text_size(11.5).text_color(t.muted).child(unit.title)))))
      .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.muted)
        .child(this.icon("branch", t.dim, 12)).child(div().min_w(0).truncate().child(s.branch ?? "—"))
        .when(Boolean(s.baseCommit), (e) => e.child(div().text_color(t.dim).child(`from ${s.baseBranch ?? "?"}@${s.baseCommit}`))))
      .child(div().id("wd").text_size(11).text_color(t.dim).truncate().font_family(settings().font_family ?? "JetBrains Mono").tooltip(s.workDir ?? "").child(H.tilde(s.workDir)));

    const actions = h_flex().px(14).py(10).gap(6).flex_wrap().border_b(1).border_color(t.border)
      .child(this.button("v-full", "Verify --full", t, () => this.verify(repo, s, true), { primary: true, icon: "play" }))
      .child(this.button("v-quick", "Verify", t, () => this.verify(repo, s, false), { icon: "check" }))
      .child(this.button("space", H.slotSpace(s, repo) ? "Go to space" : "Open space", t, () => this.openSpace(repo, s), { icon: "folder" }))
      .child(convs.length
        ? this.button("agent", `Resume · ${convs[0].title.length > 24 ? `${convs[0].title.slice(0, 23)}…` : convs[0].title}`, t, () => this.startAgent(repo, s), { icon: "terminal" })
            .tooltip(`${convs[0].agent === "codex" ? "codex resume" : "claude --resume"} ${convs[0].id} in ${H.tilde(convs[0].cwd)}`)
        : this.button("agent", `Start ${H.agentChoice()}`, t, () => this.startAgent(repo, s, true), { icon: "terminal" }))
      .when(convs.length > 0, (e) => e.child(this.button("agent-new", `New ${H.agentChoice()}`, t, () => this.startAgent(repo, s, true), { icon: "plus" })))
      .when((snap.stageIds ?? []).includes("logs"), (e) => e.child(this.button("logs", "Logs", t, () => this.tab(`logs · ${H.base(repo)}#${s.id}`, ["har", "env", "logs", String(s.id), "--repo", repo], repo), { icon: "logs" })))
      .child(this.button("mc", "Mission Control", t, () => H.openMissionControl(repo, s.id), { icon: "external" }))
      .child(this.button("complete", "Complete…", t, () => this.confirm(`Complete slot ${s.id}?`,
        `Runs har env complete ${s.id}: reuses the last passing full verify, tears the slot down and keeps branch ${s.branch ?? ""}.${f.unpushed ? ` ${f.unpushed} commit(s) are not pushed yet.` : ""}`,
        `complete · ${H.base(repo)}#${s.id}`, ["har", "env", "complete", String(s.id), "--repo", repo], repo), { danger: true }))
      .child(this.button("teardown", "Teardown…", t, () => this.confirm(`Tear down slot ${s.id}?`,
        `Runs har env teardown ${s.id}: stops the slot's services and frees it without closing the work attempt.${f.dirty ? " The worktree has uncommitted changes." : ""}`,
        `teardown · ${H.base(repo)}#${s.id}`, ["har", "env", "teardown", String(s.id), "--repo", repo], repo), { danger: true }));

    // git & PR
    const vc = verdictColor(t, f.verdict);
    const gitBlock = v_flex().px(14).gap(6)
      .child(h_flex().gap(6).items_center().flex_wrap()
        .when(Boolean(f.pr), (e) => e.child(this.prChip(f.pr, t, "d-pr")))
        .when(!f.pr, (e) => e.child(this.chip(snap.prs ? "no PR" : "PRs unknown (gh)", t.dim, t)))
        .child(this.chip(`↑${s.ahead ?? "?"} ahead · ↓${s.behind ?? "?"} behind`, t.muted, t))
        .child(this.chip(f.unpushed > 0 ? `${f.unpushed} unpushed` : f.pushed ? "pushed" : (s.ahead ?? 0) > 0 ? "not pushed" : "nothing to push", f.unpushed > 0 ? t.blocked : t.muted, t))
        .child(this.chip(f.dirty ? `${f.git?.changed ?? ""} uncommitted`.trim() : "clean", f.dirty ? t.blocked : t.muted, t))
        .when(Boolean(f.git?.merged && (s.ahead ?? 0) > 0), (e) => e.child(this.chip(`merged into ${s.baseBranch ?? "base"}`, t.ansi2, t))))
      .when(Boolean(f.pr), (e) => e.child(div().truncate().text_size(11.5).text_color(t.muted).child(f.pr.title)))
      .when(Boolean(f.git?.subject), (e) => e.child(div().truncate().text_size(11).text_color(t.dim).child(`last commit: ${f.git.subject}`)))
      .when((f.git?.remotes ?? []).length > 0, (e) => e.child(div().truncate().text_size(11).text_color(t.dim).child(`on ${f.git.remotes.join(", ")}`)))
      .child(h_flex().gap(6).items_center().text_size(11).child(this.chip(VERDICT[f.verdict], vc, t)).child(div().text_color(vc).child(f.reasons.join(" · "))));

    const previews = entries.length ? h_flex().px(14).gap(6).flex_wrap().children(entries.map(([label, url]) =>
      h_flex().id(`pv-${label}`).h(24).px(8).gap(5).items_center().rounded(6).border_1().border_color(t.border).cursor_pointer()
        .hover((e) => e.bg(t.hover)).tooltip(url).on_click(() => H.openSystemUrl(url))
        .child(div().text_size(11.5).child(label)).child(div().text_size(10.5).text_color(t.dim).child(url.replace(/^https?:\/\//, "")))
        .child(this.icon("external", t.dim, 10)))) : null;

    const convList = v_flex().px(8).gap(2).children(convs.slice(0, this.slotConvMore === s.id ? 60 : 6).map((c) =>
      h_flex().id(`sc-${c.agent}-${c.id}`).px(6).h(24).gap(8).items_center().rounded(6).cursor_pointer().hover((e) => e.bg(t.hover))
        .tooltip(`${c.title}\n${c.live ? `open in ${c.liveIn === "claude-desktop" ? "Claude Desktop" : "a terminal"}` : `${c.agent === "codex" ? "codex resume" : "claude --resume"} ${c.id} in ${H.tilde(c.cwd)}`}${c.bound ? "\nlaunched this slot (HAR session binding)" : ""}`)
        .on_click(() => this.resumeInSlot(repo, s, c))
        .child(this.icon("message", c.agent === "codex" ? t.ansi4 : t.ansi3, 11))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(c.title))
        .when(Boolean(c.live), (e) => e.child(div().text_size(10).text_color(t.working).child(c.liveIn === "claude-desktop" ? "open in Desktop" : "open")))
        .child(div().flex_none().text_size(10).text_color(t.dim).child(H.ago(c.at)))))
      .when(convs.length > 6 && this.slotConvMore !== s.id, (e) => e.child(h_flex().id("sc-more").px(6).h(22).gap(6).items_center().rounded(6).cursor_pointer()
        .hover((x) => x.bg(t.hover)).on_click((_e, cx) => { this.slotConvMore = s.id; cx.notify(); })
        .child(this.icon("chevron-down", t.dim, 11)).child(div().text_size(11).text_color(t.dim).child(`Show ${convs.length - 6} more`))));

    const agentList = v_flex().px(8).gap(2).children(agents.length ? agents.map((a) =>
      h_flex().id(`ag-${a.address}`).px(6).h(26).gap(8).items_center().rounded(6).cursor_pointer().hover((e) => e.bg(t.hover))
        .on_click(() => run("agent.focus", { terminal: a.address }))
        .child(a.status === "working" ? this.pulse(statusColor(t, a.status)) : this.dot(statusColor(t, a.status)))
        .child(div().child(a.program?.name ?? a.app ?? "agent"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).text_size(11.5).child(a.title ?? ""))
        .child(div().text_size(10.5).text_color(statusColor(t, a.status)).child(a.status)))
      : [div().px(6).text_size(11.5).text_color(t.dim).child(`No herdr agent in this worktree — Start ${H.agentChoice()} opens one here.`)]);

    const pipeHead = h_flex().gap(6).items_center()
      .child(live ? (live.running ? div().text_size(11).text_color(t.working).frames(SPIN, 90) : this.icon("circle-check", t.dim, 11)) : div())
      .child(div().text_size(10.5).text_color(live?.running ? t.working : t.dim).child(
        live ? (live.running ? `running${live.full ? " --full" : ""}` : "verify tab finished")
          : last ? `${last.status} · ${H.ago(last.at)} · ${H.dur(last.ms)}` : "no verify yet"))
      .when(Boolean(vt), (e) => e.child(div().id("show-vt").cursor_pointer().text_size(10.5).text_color(t.accent)
        .on_click(() => { run("space.select", { id: vt.space }); run("tab.select", { id: vt.tab }); }).child("show")));

    const pipeline = v_flex().px(14).gap(1).children(names.map((name, i) => {
      const r = byName.get(name);
      const finished = live ? !live.running : Boolean(last);
      const state = r?.state ?? (finished && results.length ? "unrun" : "pending");
      const c = state === "pending" ? t.dim : statusColor(t, state);
      const mark = state === "pass" ? this.icon("check", c, 12) : state === "fail" ? this.icon("fail", c, 12)
        : state === "skipped" ? this.icon("skip", c, 12) : state === "running" ? div().w(12).text_size(11).text_color(c).frames(SPIN, 90)
        : div().size(6).mx(3).rounded(3).border_1().border_color(t.dim);
      const w = r?.ms ? Math.max(2, Math.round((r.ms / maxMs) * 100)) : 0;
      return h_flex().h(22).gap(8).items_center()
        .child(div().w(14).text_size(10).text_color(t.dim).child(String(i + 1)))
        .child(h_flex().w(14).justify_center().child(mark))
        .child(div().w(110).flex_none().truncate().text_color(state === "pending" || state === "unrun" ? t.muted : t.foreground).child(name))
        .child(div().flex_1().h(6).rounded(3).bg(t.raised).child(div().h_full().rounded(3).w(`${w}%`).bg(c + "aa")))
        .child(div().w(52).text_right().text_size(11).text_color(t.dim).child(r?.ms != null ? H.dur(r.ms) : state === "unrun" ? "full only" : ""));
    }));

    const warnings = [...s.blockers, ...s.warnings];
    const hs = H.hints(snap, s);
    const hintColor = { warn: t.blocked, done: t.ansi2, info: t.muted };
    const ACTION = { free: "Free…", "verify-full": "Verify --full", push: "Push…", "push-pr": "Push & open PR…", agent: `Start ${H.agentChoice()}`, focus: "Go to agent" };
    const hintBlock = v_flex().px(14).gap(5).children(hs.map((h, i) => h_flex().gap(8).items_center()
      .child(this.dot(hintColor[h.level] ?? t.dim, 6))
      .child(div().flex_1().min_w(0).text_size(11.5).text_color(hintColor[h.level] ?? t.muted).child(h.text))
      .when(Boolean(h.action), (e) => e.child(this.button(`hint-${i}`, ACTION[h.action], t, () => this.hintAction(h.action, repo, s, h), { h: 22 })))));
    // Default order (SECTIONS.slot): what the slot's code does (pipeline), what it costs (usage), whether it can
    // run (readiness), where it stands (git & PR), then the rest.
    return [
      header, actions,
      ...this.arrange("slot", {
        pipeline: [this.section("Verification pipeline", t, pipeHead), pipeline],
        usage: [this.section("Usage · OTel", t, snap.usage?.error ? div().text_size(10.5).text_color(t.blocked).child(snap.usage.error) : null),
          ...(snap.usage?.error ? [] : [this.usageBlock(f.usage, t, { label: "This slot", empty: "No OTel usage attributed to this slot yet." })])],
        readiness: warnings.length ? [this.section("Readiness", t), v_flex().px(14).gap(4).children(warnings.map((w) =>
          div().text_size(11).text_color(t.blocked).child(`⚠ ${w}`)))] : [],
        git: [this.section("Git & PR", t), gitBlock],
        hints: hs.length ? [this.section("Next steps", t), hintBlock] : [],
        worktree: this.worktreeBlock(s, t),
        previews: previews ? [this.section("Previews", t), previews] : [],
        agents: [this.section(`Agents in this slot · ${agents.length}`, t), agentList],
        convs: convs.length ? [this.section(`Conversations · ${convs.length}`, t), convList] : [],
        runs: [this.section(`Runs · slot ${s.id}`, t), this.runList(repo, runs, t, false)],
      }, t),
    ];
  }

  /** WORKTREE: clean or dirty, the branch against its base and upstream, the changed files (click: the diff in
   *  a tab) and a graph of the branch's commits beside its base's, the uncommitted changes as a dashed top row. */
  worktreeBlock(s, t) {
    if (!s.active || !s.workDir) return [];
    const w = H.worktree(s, () => this.cx?.notify());
    if (!w) return [this.section("Worktree", t), div().px(14).text_size(11.5).text_color(t.dim).child("reading git…")];
    if (w.error) return [this.section("Worktree", t), div().px(14).text_size(11).text_color(t.ansi1).child(w.error)];
    const state = w.dirty ? this.chip(`dirty · ${w.files.length} file${w.files.length === 1 ? "" : "s"}`, t.blocked, t) : this.chip("clean", t.ansi2, t);
    const vs = (a, b, what) => `${a ? `↑${a}` : "↑0"} ${b ? `↓${b}` : "↓0"} ${what}`;
    const summary = v_flex().px(14).gap(3)
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(this.icon("branch", t.muted, 12))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_family(mono()).child(w.branch ?? "detached HEAD")))
      .child(h_flex().gap(10).text_size(10.5).text_color(t.dim)
        .child(w.base ? div().text_color(w.behind ? t.blocked : t.dim).child(vs(w.ahead, w.behind, w.base)) : div().child("no base branch"))
        .child(div().text_color(w.upAhead ? t.blocked : t.dim).child(w.upstream ? vs(w.upAhead, w.upBehind, w.upstream) : "not pushed")));

    const ST = { M: [t.ansi3, "modified"], A: [t.ansi2, "added"], "?": [t.ansi2, "untracked"], D: [t.ansi1, "deleted"],
      R: [t.ansi4, "renamed"], C: [t.ansi4, "copied"], U: [t.ansi5, "conflict"], T: [t.ansi3, "type changed"] };
    const many = this.wtAllFiles === s.workDir ? w.files : w.files.slice(0, 10);
    const files = v_flex().px(8).gap(1).children(many.map((f) => {
      const [c, word] = ST[f.st] ?? [t.muted, f.st];
      const slash = f.path.lastIndexOf("/");
      const hov = this.hoverFile === `${s.workDir}/${f.path}`;
      const staging = f.staged && f.unstaged ? "partly staged" : f.staged ? "staged" : "not staged";
      return h_flex().id(`wf-${f.path}`).h(22).px(6).gap(7).items_center().rounded(5).cursor_pointer().hover((e) => e.bg(t.hover))
        .tooltip(`${word}, ${staging}: ${f.from ? `${f.from} → ` : ""}${f.path}\nclick: the diff in a tab`)
        .on_click(() => this.showDiff(s, f))
        .on_hover((on, cx) => { const k = `${s.workDir}/${f.path}`; if (on) this.hoverFile = k; else if (this.hoverFile === k) this.hoverFile = null; cx.notify(); })
        .child(div().w(10).flex_none().text_size(10.5).font_semibold().font_family(mono()).text_color(c).child(f.st === "?" ? "U" : f.st))
        .child(div().size(5).flex_none().rounded(3).bg(f.staged && !f.unstaged ? t.ansi2 : f.staged ? t.ansi2 + "77" : CLEAR)
          .when(f.staged || f.unstaged, (e) => e.border_1().border_color(f.staged ? t.ansi2 : t.dim)))
        .child(h_flex().flex_1().min_w(0).gap(0).text_size(11.5)
          .child(div().flex_none().text_color(t.foreground).child(f.path.slice(slash + 1)))
          .child(div().flex_1().min_w(0).pl(6).truncate().text_size(10.5).text_color(t.dim).child(slash > 0 ? f.path.slice(0, slash) : "")))
        .when(!hov, (e) => e
          .child(div().flex_none().text_size(10.5).font_family(mono()).text_color(t.ansi2).child(f.add ? `+${f.add}` : f.st === "?" ? "new" : ""))
          .child(div().flex_none().text_size(10.5).font_family(mono()).text_color(t.ansi1).child(f.del ? `−${f.del}` : "")))
        .when(hov, (e) => e.child(h_flex().flex_none().gap(1)
          .when(f.st !== "D", (x) => x.child(this.miniBtn(`wf-open-${f.path}`, "external", "Open in your editor", t, () => this.openFile(s, f))))
          .when(f.unstaged || f.st === "?", (x) => x.child(this.miniBtn(`wf-add-${f.path}`, "plus", `Stage (git add)`, t, () => this.gitFile(s, ["add", "--", f.path], `Staged ${f.path}`))))
          .when(f.staged, (x) => x.child(this.miniBtn(`wf-reset-${f.path}`, "minus", "Unstage (git restore --staged)", t, () => this.gitFile(s, ["restore", "--staged", "--", f.path], `Unstaged ${f.path}`))))
          .child(this.miniBtn(`wf-discard-${f.path}`, "undo-2", f.st === "?" ? "Delete this new file…" : "Discard changes (back to HEAD)…", t,
            () => this.gitDialog(s, { mode: "discard", file: f.path, st: f.st }), t.ansi1))));
    }))
      .when(w.files.length > many.length, (e) => e.child(h_flex().id("wf-more").h(22).px(6).gap(6).items_center().rounded(5).cursor_pointer()
        .hover((x) => x.bg(t.hover)).on_click((_e, cx) => { this.wtAllFiles = s.workDir; cx.notify(); })
        .child(this.icon("chevron-down", t.dim, 11)).child(div().text_size(11).text_color(t.dim).child(`${w.files.length - many.length} more`))));

    const staged = w.files.filter((f) => f.staged).length, unstaged = w.files.filter((f) => f.unstaged || f.st === "?").length;
    const tools = h_flex().px(14).pt(6).gap(6).flex_wrap()
      .when(unstaged > 0, (e) => e.child(this.button("wt-add", "Stage all", t, () => this.gitFile(s, ["add", "-A"], "Staged everything"), { icon: "plus", h: 24 })))
      .when(staged > 0, (e) => e.child(this.button("wt-unstage", "Unstage all", t, () => this.gitFile(s, ["reset", "-q"], "Unstaged everything"), { icon: "minus", h: 24 })))
      .when(w.dirty, (e) => e.child(this.button("wt-commit", staged ? `Commit ${staged}…` : "Commit all…", t, () => this.gitDialog(s, { mode: "commit", staged }), { icon: "git-commit", h: 24 })))
      .child(this.button("wt-branch", "Branch…", t, () => this.gitDialog(s, { mode: "branch", hash: "HEAD", short: "HEAD" }), { icon: "git-branch-plus", h: 24 }));
    return [this.section("Worktree", t, state), summary, tools,
      ...(w.files.length ? [div().h(4), files] : []),
      ...(w.commits.length ? [div().h(6), (this.graphSlot = s, this.graph(w, t))] : [])];
  }

  /** The branch's commits beside its base's, drawn on lanes (herdr-git-graph's layout). */
  graph(w, t) {
    const commits = w.dirty && w.commits[0]
      ? [{ hash: "~worktree", short: "", parents: [w.commits.find((c) => c.head)?.hash ?? w.commits[0].hash], subject: `Uncommitted changes · ${w.files.length} file${w.files.length === 1 ? "" : "s"}`,
          uncommitted: true, dashed: true, refs: [], others: 0, mine: true }, ...w.commits]
      : w.commits;
    const { rows, width } = layoutLanes(commits);
    const colors = [t.accent, t.ansi4, t.ansi5, t.ansi3, t.ansi6, t.ansi1];
    const gw = LANE_PAD * 2 + Math.min(width, 6) * LANE;
    const x = (lane) => LANE_PAD + lane * LANE + LANE / 2;
    const cell = (row, c) => {
      const paths = new Map();
      for (const [a, ya, b, yb, k, dashed] of row.segments) {
        const color = dashed ? t.dim : colors[k % colors.length], key = `${color}${dashed ? "-" : ""}`;
        let p = paths.get(key)?.p ?? (dashed ? PathBuilder.stroke(1.5).dash_array([3, 3]) : PathBuilder.stroke(1.5));
        p = p.move_to(x(a), ya * ROW);
        if (a === b) p = p.line_to(x(b), yb * ROW);
        else { const mid = (ya * ROW + yb * ROW) / 2; p = p.cubic_bezier_to(x(b), yb * ROW, x(a), mid, x(b), mid); }
        paths.set(key, { p, color });
      }
      const color = c.uncommitted ? t.dim : colors[row.lane % colors.length];
      const dot = div().absolute().left(x(row.lane) - 4).top(ROW / 2 - 4).size(8).rounded(4);
      return div().relative().flex_none().w(gw).h(ROW).overflow_hidden()
        .children([...paths.values()].map(({ p, color }) => window.paint_path(p.build(), color).absolute().top(0).left(0).size_full()))
        .child(c.head || c.uncommitted ? dot.bg(t.background).border(2).border_color(color) : dot.bg(color));
    };
    const label = (r) => {
      const tag = r.startsWith("tag:"), mine = r === w.branch, up = r === w.upstream;
      const c = tag ? t.ansi3 : mine ? t.accent : up ? t.ansi4 : t.muted;
      return div().flex_none().max_w(150).truncate().px(4).rounded(4).border_1().border_color(c + "88").bg(mine ? c + "22" : CLEAR)
        .text_size(9.5).font_family(mono()).text_color(c).child(tag ? r.slice(4) : r === w.branch ? "this branch" : r);
    };
    const slot = this.graphSlot;
    return v_flex().px(8).children(commits.map((c, i) =>
      h_flex().id(`wg-${c.hash}`).h(ROW).pr(6).gap(6).items_center().rounded(5).hover((e) => e.bg(t.hover))
        .on_hover((on, cx) => { if (on) this.hoverCommit = c.hash; else if (this.hoverCommit === c.hash) this.hoverCommit = null; cx.notify(); })
        .tooltip(c.uncommitted ? "Not committed yet" : `${c.short} · ${c.author} · ${new Date(c.at).toLocaleString()}\n${c.subject}${c.others ? `\n+${c.others} other branch${c.others === 1 ? "" : "es"} here` : ""}`)
        .child(cell(rows[i], c))
        .children(c.refs.map(label))
        .when(c.others > 0 && !c.refs.length, (e) => e.child(div().flex_none().text_size(9.5).text_color(t.dim).child(`+${c.others}`)))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(c.uncommitted ? t.blocked : c.mine ? t.foreground : t.muted)
          .when(Boolean(c.uncommitted), (e) => e.italic()).child(c.subject))
        .when(this.hoverCommit !== c.hash || c.uncommitted || !slot, (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child(c.at ? H.ago(c.at) : "")))
        .when(this.hoverCommit === c.hash && !c.uncommitted && Boolean(slot), (e) => e.child(h_flex().flex_none().gap(1)
          .child(this.miniBtn(`wg-show-${c.hash}`, "eye", "Show this commit (git show) in a tab", t, () => this.showCommit(slot, c)))
          .child(this.miniBtn(`wg-br-${c.hash}`, "git-branch-plus", "New branch from this commit…", t,
            () => this.gitDialog(slot, { mode: "branch", hash: c.hash, short: c.short })))))));
  }

  miniBtn(id, icon, tip, t, on, color) {
    return div().id(id).size(20).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
      .hover((e) => e.bg((color ?? t.foreground) + "22")).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); on(cx); })
      .child(this.icon(icon, color ?? t.muted, 12));
  }

  /** git in the slot's worktree, then a notification on failure and a fresh read. */
  gitFile(s, args, done) {
    H.git(s.workDir, args).then((r) => {
      if (!r.ok) notify({ title: `git ${args[0]} failed`, body: r.out.slice(0, 400), level: "error", timeout: 8000 });
      else if (done) notify({ title: done, level: "success", timeout: 2500 });
      H.rereadWorktree(s); this.cx?.notify();
    });
  }

  gitDialog(s, opts) {
    openOverlay({ mod: "har", kind: "dialog", width: 460, height: opts.mode === "commit" ? 260 : 220,
      props: { view: "git", workDir: s.workDir, branch: s.branch, ...opts } });
  }

  openFile(s, f) {
    H.openInEditor(s.workDir, f.path).then((gui) => {
      if (!gui) this.tab(f.path.split("/").pop(), ["bash", "-ic", `\${VISUAL:-\${EDITOR:-vi}} "$1"; exec "\${SHELL:-bash}"`, "edit", f.path], s.workDir,
        { space: H.slotSpace(s)?.id });
    });
  }

  showCommit(s, c) {
    this.tab(`show · ${c.short}`, ["bash", "-c", `git show --stat --patch "$1"; exec "\${SHELL:-bash}"`, "show", c.hash], s.workDir, { space: H.slotSpace(s)?.id });
  }

  /** The git dialog: a new branch (from HEAD or a commit, not checked out: the slot keeps its own branch), a
   *  commit of the staged changes (or of everything), or confirming a discard. */
  renderGit(t, cx) {
    const p = props() ?? {};
    const close = () => closeOverlay(p.overlay);
    const title = p.mode === "branch" ? `New branch from ${p.short === "HEAD" ? "this worktree's HEAD" : p.short}`
      : p.mode === "commit" ? (p.staged ? `Commit ${p.staged} staged file${p.staged === 1 ? "" : "s"}` : "Commit") : "Discard changes?";
    const note = p.mode === "branch" ? `Created from ${p.short === "HEAD" ? p.branch : p.short}, not checked out: the slot stays on ${p.branch}, so HAR keeps tracking it.`
      : p.mode === "commit" ? `On ${p.branch}, in ${H.tilde(p.workDir)}.`
      : p.st === "?" ? `${p.file} is a new file: it will be deleted. This can't be undone.`
      : `${p.file} goes back to its last committed version, staged and unstaged changes alike. This can't be undone.`;
    const label = this.gitBusy ? "…" : p.mode === "branch" ? "Create branch" : p.mode === "commit" ? "Commit" : p.st === "?" ? "Delete file" : "Discard";
    return v_flex().id("har-git").track_focus(this.handle).size_full().min_h(0).p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { close(); cx.stop_propagation(); }
        else if (e.key === "enter" && p.mode === "discard") { this.gitGo(cx); cx.stop_propagation(); }
      })
      .child(h_flex().items_center().gap(8)
        .child(this.icon(p.mode === "discard" ? "undo-2" : p.mode === "commit" ? "git-commit" : "git-branch-plus", p.mode === "discard" ? t.ansi1 : t.accent, 15))
        .child(div().flex_1().text_size(14).font_semibold().child(title))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().text_size(11.5).text_color(p.mode === "discard" ? t.ansi1 : t.muted).child(note))
      .when(p.mode !== "discard", (e) => e.child(Input.new(this.gitInput).h(32).px(9).rounded(7).border_1().border_color(t.input).bg(t.background)
        .text_size(12.5).text_color(t.foreground).font_family(p.mode === "branch" ? mono() : undefined)))
      .when(p.mode === "commit" && p.staged > 0, (e) => e.child(h_flex().id("git-all").gap(8).items_center().cursor_pointer()
        .on_click((_e, cx) => { this.stageAll = !this.stageAll; cx.notify(); })
        .child(div().size(14).rounded(4).border_1().border_color(this.stageAll ? t.accent : t.input).bg(this.stageAll ? t.accent : CLEAR)
          .flex().items_center().justify_center().when(this.stageAll, (x) => x.child(this.icon("check", t.background, 10))))
        .child(div().text_size(11.5).text_color(t.muted).child("Stage everything first (git add -A)"))))
      .when(Boolean(this.gitError), (e) => e.child(div().text_size(11.5).text_color(t.ansi1).child(this.gitError)))
      .child(div().flex_1())
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1())
        .child(this.button("git-cancel", "Cancel", t, close, { h: 30 }))
        .child(this.button("git-go", label, t, (cx) => this.gitGo(cx), { primary: true, danger: p.mode === "discard", h: 30 })));
  }

  async gitGo(cx) {
    const p = props() ?? {};
    if (this.gitBusy) return;
    const text = (this.gitInput?.value() ?? "").trim();
    const fail = (msg) => { this.gitBusy = false; this.gitError = msg; cx.notify(); };
    this.gitBusy = true; this.gitError = null; cx.notify();
    let r, done;
    if (p.mode === "branch") {
      const bad = await H.checkBranch(p.workDir, text);
      if (bad) return fail(bad);
      r = await H.git(p.workDir, ["branch", text, p.hash ?? "HEAD"]);
      done = `Branch ${text} created at ${p.short === "HEAD" ? "HEAD" : p.short}`;
    } else if (p.mode === "commit") {
      if (!text) return fail("Type a commit message.");
      if (this.stageAll || !p.staged) { const a = await H.git(p.workDir, ["add", "-A"]); if (!a.ok) return fail(a.out); }
      r = await H.git(p.workDir, ["commit", "-m", text]);
      done = r.ok ? r.out.split("\n")[0] : null;
    } else {
      r = p.st === "?" ? await H.git(p.workDir, ["clean", "-f", "--", p.file])
        : await H.git(p.workDir, ["restore", "--source=HEAD", "--staged", "--worktree", "--", p.file]);
      done = p.st === "?" ? `Deleted ${p.file}` : `Discarded changes to ${p.file}`;
    }
    if (!r.ok) return fail(r.out.slice(0, 500));
    notify({ title: done, level: "success", timeout: 3000 });
    closeOverlay(p.overlay);
  }

  /** A changed file's diff against HEAD, paged in a tab of the slot's space (a new file: all of it). */
  showDiff(s, f) {
    const diff = f.st === "?" ? `git diff --no-index -- /dev/null "$1"` : `git diff HEAD -M -- "$1"`;
    this.tab(`diff · ${f.path.split("/").pop()}`, ["bash", "-c", `${diff}; exec "\${SHELL:-bash}"`, "diff", f.path], s.workDir,
      { space: H.slotSpace(s)?.id });
  }

  runList(repo, runs, t, showSlot) {
    if (!runs.length) return div().px(14).text_size(11.5).text_color(t.dim).child("No runs recorded.");
    return v_flex().px(8).gap(1).children(runs.map((r) =>
      h_flex().id(`run-${r.id}`).h(24).px(6).gap(8).items_center().rounded(5).cursor_pointer().hover((e) => e.bg(t.hover))
        .tooltip(`har env runs get ${r.id}`)
        .on_click(() => this.tab(`run ${r.id.slice(0, 8)}`, ["har", "env", "runs", "get", r.id, "--repo", repo], repo))
        .child(this.dot(statusColor(t, r.status), 7))
        .when(showSlot, (e) => e.child(div().w(22).text_size(11).text_color(t.muted).child(r.slot != null ? `#${r.slot}` : "")))
        .child(div().w(80).flex_none().truncate().child(r.stage + (r.full ? " ·full" : "")))
        .child(r.stages ? h_flex().w(90).flex_none().child(this.strip(r.stages.map((x) => x.name), r.stages, t, 5)) : div().w(90))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(H.dur(r.ms)))
        .child(div().w(56).text_right().text_size(11).text_color(t.dim).child(H.ago(r.at)))));
  }

  renderStatus(t) {
    const repo = H.currentRepo(), snap = repo ? H.snapshot(repo) : null;
    const slots = snap?.slots ?? [], active = slots.filter((s) => s.active);
    const failing = active.filter((s) => s.lastVerify === "fail").length;
    const stale = active.filter((s) => s.stale).length;
    const agents = active.flatMap((s) => H.slotAgents(s));
    const blocked = agents.filter((a) => a.status === "blocked").length, working = agents.filter((a) => a.status === "working").length;
    const ru = snap && !snap.usage?.error ? H.repoUsage(snap).all : null;
    const item = (icon, text, color) => h_flex().gap(5).items_center().child(this.icon(icon, color ?? t.dim, 12)).child(div().text_color(color ?? t.muted).child(text));
    const space = H.spaceIndex().all.find((s) => s.active);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted)
      .child(item("har", repo ? `${H.base(repo)} · ${snap?.profile ?? "…"}` : "no harness", t.accent))
      .child(item("layers", `${active.length}/${slots.length} slots`))
      .child(item("terminal", `${working} working`, working ? t.working : undefined))
      .when(blocked > 0, (e) => e.child(item("terminal", `${blocked} need you`, t.blocked)))
      .when(failing > 0, (e) => e.child(item("fail", `${failing} failing verify`, t.ansi1)))
      .when(stale > 0, (e) => e.child(item("git-compare", `${stale} stale`, t.blocked)))
      .when(Boolean(ru?.sessions), (e) => e.child(div().text_color(t.muted).tooltip("OTel usage recorded for this repository (Mission Control)")
        .child(`${H.money(ru.cost)} · ${H.tokens(ru.tokens)} tokens`)))
      .child(div().flex_1())
      // the shown space: its machine when it isn't this one, its branch (as Herdr's own status bar has them)
      .when(Boolean(space?.machine), (e) => e.child(item("server", space.machine)))
      .when(Boolean(space?.branch), (e) => e.child(item("branch", space.branch)))
      .when(Boolean(snap?.at), (e) => e.child(div().text_color(t.dim).child(`updated ${H.ago(new Date(snap.at).toISOString())}`)))
      .child(div().id("st-mc").cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .on_click(() => repo && H.openMissionControl(repo, H.currentSlot())).child("Mission Control ↗"))
      .child(div().id("st-palette").cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .tooltip("Every Herdr and HAR command").on_click(() => run("app.palette")).child(paletteHint()));
  }
}

// The palette key as keys.json binds it (as Herdr's status bar shows it), or just "commands" when unbound.
function paletteHint() {
  const mac = appWindow()?.platform === "macos";
  const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
  const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
  const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
  const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
  return key ? `${key}  commands` : "commands";
}

function openSettings() { return openOverlay({ mod: "har", kind: "dialog", width: 480, height: 800, props: { view: "settings" } }); }

function rank(v) { return { free: 0, safe: 1, caution: 2, keep: 3 }[v] ?? 4; }
