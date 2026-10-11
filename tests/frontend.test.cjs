const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const Renderer = require("react-test-renderer");
const jsx = require("react/jsx-runtime");
const { act } = React;

global.IS_REACT_ACT_ENVIRONMENT = true;
const root = path.resolve(__dirname, "..");
const Visibility = React.createContext(true);
const initialStatus = {
  ok: true,
  epoch: Math.floor(new Date(2026, 0, 31, 9, 15).getTime() / 1000),
  ntp_enabled: false,
  ntp_synced: false,
  timezone: "Asia/Shanghai",
};
class TestDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : [initialStatus.epoch * 1000]));
  }
  static now() { return initialStatus.epoch * 1000; }
}

function load(filename, modules, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, filename), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, Date: TestDate, window: {},
    require(name) {
      assert.ok(name in modules, `Unexpected import: ${name}`);
      return modules[name];
    },
    ...globals,
  }, { filename });
  return module.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function mount(t, backend = async () => initialStatus) {
  const timers = new Map();
  const calls = [];
  const toasts = [];
  let timerId = 0;
  const common = { react: React, "react/jsx-runtime": jsx };
  const ui = Object.fromEntries([
    "ButtonItem", "DialogButton", "Dropdown", "Focusable", "PanelSection", "PanelSectionRow",
  ].map(name => [name, name]));
  ui.staticClasses = {};
  ui.quickAccessControlsClasses = { PanelSection: "PanelSection" };
  ui.gamepadUIClasses = { OpaqueBackground: "OpaqueBackground" };
  const factory = load("src/index.tsx", {
    ...common,
    "@decky/ui": ui,
    "@decky/api": {
      definePlugin: fn => fn,
      useQuickAccessVisible: () => React.useContext(Visibility),
      callable: name => (...args) => { calls.push({ name, args }); return backend(name, args); },
      toaster: { toast: toast => toasts.push(toast) },
    },
    "react-icons/fa": { FaClock: "clock-icon" },
    "./translations": load("src/translations.ts", common),
  }, {
    setInterval(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearInterval(id) { timers.delete(id); },
  }).default;
  const plugin = factory();
  // Match Decky's visibility condition: hidden content normally unmounts.
  const tree = visible => React.createElement(Visibility.Provider, { value: visible },
    (visible || plugin.alwaysRender) ? plugin.content : null);
  let renderer;
  await act(async () => { renderer = Renderer.create(tree(true)); });
  t.after(async () => {
    await act(async () => renderer.unmount());
    assert.equal(timers.size, 0, "Unmount must release every timer");
  });
  const dropdowns = () => renderer.root.findAllByType("Dropdown");
  const button = label => renderer.root.findAllByType("ButtonItem").find(node => node.props.children === label);
  return {
    calls, toasts, timers, dropdowns, button,
    quick: label => renderer.root.findAllByType("DialogButton").find(node => node.props.children === label),
    clock: () => renderer.root.findAllByType("div").find(node => node.props.style?.fontSize === "1.1em").props.children,
    ntp: () => {
      // the status line lives inside the sticky clock block (not the restore hint, which shares its text style)
      const clockBlock = renderer.root.findAllByType("div").find(node => node.props.style?.position === "sticky");
      return clockBlock.props.children.find(child => child?.props?.style?.opacity === 0.7).props.children;
    },
    visible: value => act(async () => renderer.update(tree(value))),
    choose: (index, data) => act(async () => {
      const field = dropdowns()[index];
      assert.equal(field.props.disabled, false);
      field.props.onChange({ data, label: String(data).padStart(2, "0") });
    }),
    tick: delay => act(async () => {
      for (const timer of [...timers.values()]) if (timer.delay === delay) timer.fn();
    }),
  };
}

test("initial load disables the picker; later status reads preserve edited values", async t => {
  const pending = deferred();
  let current = initialStatus;
  let first = true;
  const app = await mount(t, async () => {
    if (first) { first = false; return pending.promise; }
    return current;
  });
  assert.ok(app.dropdowns().every(field => field.props.disabled));
  assert.equal(app.button("Set to This Time").props.disabled, true);
  await act(async () => app.button("Set to This Time").props.onClick());
  assert.equal(app.calls.filter(call => call.name === "set_time").length, 0);
  await act(async () => pending.resolve(initialStatus));
  await app.choose(4, 59);
  current = { ...initialStatus, epoch: initialStatus.epoch + 3600 };
  await app.tick(5000);
  assert.equal(app.dropdowns()[4].props.selectedOption, 59);
});

test("QAM hide/show preserves selection and stops background polling", async t => {
  const app = await mount(t);
  const callback = app.dropdowns()[1].props.onChange;
  await app.visible(false);
  assert.equal(app.timers.size, 0);
  await act(async () => callback({ data: 2, label: "02" }));
  await app.visible(true);
  assert.equal(app.dropdowns()[1].props.selectedOption, 2);
  assert.equal(app.timers.size, 2);
});

test("NTP sync updates the clock and status while the panel stays open", async t => {
  let current = initialStatus;
  const app = await mount(t, async name => {
    if (name === "restore_time") current = { ...current, ntp_enabled: true };
    return current;
  });
  await act(async () => app.button("Restore Real Time (NTP)").props.onClick());
  current = { ...current, epoch: initialStatus.epoch + 86400, ntp_synced: true };
  await app.tick(5000);
  assert.equal(app.clock(), "2026-02-01 09:15:00");
  assert.equal(app.ntp(), "NTP auto-sync active");
});

test("manual mode takes precedence over a retained kernel sync flag", async t => {
  const app = await mount(t, async () => ({ ...initialStatus, ntp_synced: true }));
  assert.equal(app.ntp(), "Manual time · Asia/Shanghai");
});

test("an old status read cannot overwrite a completed time operation", async t => {
  const oldRead = deferred();
  let current = initialStatus;
  let reads = 0;
  const app = await mount(t, async name => {
    if (name === "get_status" && ++reads === 2) return oldRead.promise;
    if (name === "shift_time") current = { ...initialStatus, epoch: initialStatus.epoch + 3600 };
    return current;
  });
  await app.tick(5000);
  // Quick actions can complete before React renders an intermediate busy state.
  await act(async () => app.quick("+1h").props.onClick());
  await act(async () => oldRead.resolve(initialStatus));
  assert.equal(app.clock(), "2026-01-31 10:15:00");
});

test("polls do not overlap and repeated errors produce one notification", async t => {
  const pending = deferred();
  let reads = 0;
  const app = await mount(t, async () => {
    reads++;
    return reads === 1 ? pending.promise : { ok: false, error: "offline" };
  });
  await app.tick(5000);
  await app.tick(5000);
  assert.equal(reads, 1);
  await act(async () => pending.resolve({ ok: false, error: "offline" }));
  await app.tick(5000);
  assert.equal(reads, 2);
  assert.equal(app.toasts.length, 1);
});

test("polling recovers after rejected requests without repeated error notifications", async t => {
  let reads = 0;
  const app = await mount(t, async () => {
    if (++reads < 3) throw new Error("connection unavailable");
    return initialStatus;
  });
  assert.ok(app.dropdowns().every(field => field.props.disabled));
  await app.tick(5000);
  assert.equal(app.toasts.length, 1);
  await app.tick(5000);
  assert.ok(app.dropdowns().every(field => !field.props.disabled));
  assert.equal(app.toasts.length, 1);
});

test("failed operations update actual NTP state and show failure only", async t => {
  const failed = { ...initialStatus, ok: false, ntp_enabled: true, error: "time change failed" };
  let current = initialStatus;
  const app = await mount(t, async name => {
    if (name === "set_time") { current = { ...failed, ok: true }; return failed; }
    return current;
  });
  await act(async () => app.button("Set to This Time").props.onClick());
  assert.equal(app.toasts.length, 1);
  assert.equal(app.toasts[0].title, "Operation failed");
  assert.equal(app.toasts[0].body, failed.error);
  // The failure response contains a valid current-time snapshot.
  assert.equal(app.clock(), "2026-01-31 09:15:00");
  assert.equal(app.ntp(), "NTP enabled (not synced)");
});

test("two clicks before a rerender cannot start overlapping operations", async t => {
  const operation = deferred();
  const app = await mount(t, async name => name === "shift_time" ? operation.promise : initialStatus);
  const click = app.quick("+1h").props.onClick;
  await act(async () => { void click(); void click(); });
  assert.equal(app.calls.filter(call => call.name === "shift_time").length, 1);
  assert.ok(app.dropdowns().every(field => field.props.disabled));
  await act(async () => operation.resolve(initialStatus));
  assert.equal(app.toasts.length, 1);
});

test("calendar changes, clock ticks, and submission keep the selected date", async t => {
  let sent;
  const app = await mount(t, async (name, args) => {
    if (name === "set_time") sent = args[0];
    return { ...initialStatus, epoch: sent ?? initialStatus.epoch };
  });
  await app.choose(0, 2028);
  await app.choose(1, 2);
  assert.equal(app.dropdowns()[2].props.selectedOption, 29);
  await app.choose(0, 2027);
  assert.equal(app.dropdowns()[2].props.selectedOption, 28);
  await app.choose(2, 21);
  await app.choose(3, 23);
  await app.choose(4, 59);
  const options = app.dropdowns().map(field => field.props.rgOptions);
  await app.tick(1000);
  app.dropdowns().forEach((field, index) => assert.equal(field.props.rgOptions, options[index]));
  await act(async () => app.button("Set to This Time").props.onClick());
  assert.equal(sent, Math.floor(new Date(2027, 1, 21, 23, 59).getTime() / 1000));
  assert.equal(app.dropdowns()[4].props.selectedOption, 59);
});
