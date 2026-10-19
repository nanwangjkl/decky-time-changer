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
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function mount(t, backend = async () => initialStatus) {
  const timers = new Map();
  const calls = [];
  const toasts = [];
  let timerId = 0;
  const common = { react: React, "react/jsx-runtime": jsx };
  const ui = Object.fromEntries([
    "ButtonItem", "DialogButton", "Focusable", "PanelSection", "PanelSectionRow", "SliderField",
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
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
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
  const sliders = () => renderer.root.findAllByType("SliderField");
  const button = label => renderer.root.findAllByType("ButtonItem").find(node => node.props.children === label);
  return {
    calls, toasts, timers, sliders, button,
    quick: label => renderer.root.findAllByType("DialogButton").find(node => node.props.children === label),
    clock: () => renderer.root.findAllByType("div").find(node => node.props.style?.fontSize === "1.1em").props.children,
    ntp: () => {
      // the status line lives inside the sticky clock block (not the restore hint, which shares its text style)
      const clockBlock = renderer.root.findAllByType("div").find(node => node.props.style?.position === "sticky");
      return clockBlock.props.children.find(child => child?.props?.style?.opacity === 0.7).props.children;
    },
    visible: value => act(async () => renderer.update(tree(value))),
    unmount: () => act(async () => renderer.unmount()),
    slide: (index, value) => act(async () => {
      const field = sliders()[index];
      assert.equal(field.props.disabled, false);
      field.props.onChange(value);
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
  assert.ok(app.sliders().every(field => field.props.disabled));
  assert.equal(app.button("Set to This Time").props.disabled, true);
  await act(async () => app.button("Set to This Time").props.onClick());
  assert.equal(app.calls.filter(call => call.name === "set_time").length, 0);
  await act(async () => pending.resolve(initialStatus));
  await app.slide(4, 59);
  current = { ...initialStatus, epoch: initialStatus.epoch + 3600 };
  await app.tick(5000);
  assert.equal(app.sliders()[4].props.value, 59);
});

test("QAM hide/show preserves selection and stops background polling", async t => {
  const app = await mount(t);
  const callback = app.sliders()[1].props.onChange;
  await app.visible(false);
  assert.equal(app.timers.size, 0);
  await act(async () => callback(2));
  await app.visible(true);
  assert.equal(app.sliders()[1].props.value, 2);
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
  assert.ok(app.sliders().every(field => field.props.disabled));
  await app.tick(5000);
  assert.equal(app.toasts.length, 1);
  await app.tick(5000);
  assert.ok(app.sliders().every(field => !field.props.disabled));
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
  assert.ok(app.sliders().every(field => field.props.disabled));
  await act(async () => operation.resolve(initialStatus));
  await app.tick(1500); // success toast waits for the merge window
  assert.equal(app.toasts.length, 1);
});

test("rapid shifts merge into one accumulated toast", async t => {
  let current = initialStatus;
  const app = await mount(t, async name => {
    if (name === "shift_time") current = { ...current, epoch: current.epoch + 3600, ntp_enabled: false };
    return current;
  });
  await act(async () => { void app.quick("+1h").props.onClick(); });
  await act(async () => { void app.quick("+1h").props.onClick(); });
  assert.equal(app.toasts.length, 0, "no toast before the merge window closes");
  await app.tick(1500);
  const bodies = app.toasts.map(x => x.body);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /\+2h|\+2 ?h/);
  assert.match(bodies[0], /2026-01-31 11:15:00/);
  assert.match(bodies[0], /NTP off until restored/);
});

test("a custom set flushes the pending shift toast first", async t => {
  let current = initialStatus;
  const app = await mount(t, async (name, args) => {
    if (name === "shift_time") current = { ...initialStatus, epoch: initialStatus.epoch + 3600 };
    if (name === "set_time") {
      assert.equal(app.toasts.length, 1, "settle the old toast before changing the clock");
      current = { ...initialStatus, epoch: args[0] };
    }
    return current;
  });
  await app.slide(1, 2);
  await app.slide(2, 1);
  await act(async () => { void app.quick("+1h").props.onClick(); });
  await act(async () => { void app.button("Set to This Time").props.onClick(); });
  const bodies = app.toasts.map(x => x.body);
  assert.equal(bodies.length, 2, "shift settle + set toast");
  assert.match(bodies[0], /\+1h/);
  assert.match(bodies[0], /2026-01-31 10:15:00/);
  assert.match(bodies[1], /2026-02-01 09:15:00/);
  await app.tick(1500);
  assert.equal(app.toasts.length, 2, "no duplicate after the window");
});

test("restoring NTP settles the shift snapshot before enabling synchronization", async t => {
  let current = initialStatus;
  const app = await mount(t, async name => {
    if (name === "shift_time") current = { ...initialStatus, epoch: initialStatus.epoch + 3600 };
    if (name === "restore_time") {
      assert.equal(app.toasts.length, 1, "settle the NTP-off toast before restoring NTP");
      current = { ...initialStatus, epoch: initialStatus.epoch + 86400, ntp_enabled: true };
    }
    return current;
  });
  await act(async () => app.quick("+1h").props.onClick());
  await act(async () => app.button("Restore Real Time (NTP)").props.onClick());
  assert.equal(app.toasts.length, 2);
  assert.match(app.toasts[0].body, /\+1h → 2026-01-31 10:15:00/);
  assert.equal(app.toasts[1].body, "NTP re-enabled. It will resync to real time once online.");
  assert.equal(app.ntp(), "NTP enabled (not synced)");
  await app.tick(1500);
  assert.equal(app.toasts.length, 2);
});

for (const action of ["shift_time", "set_time", "restore_time"]) {
  test(`a late ${action} success after unmount creates no timers or toasts`, async t => {
    const operation = deferred();
    const app = await mount(t, async name => name === action ? operation.promise : initialStatus);
    const click = action === "shift_time" ? app.quick("+1h").props.onClick
      : app.button(action === "set_time" ? "Set to This Time" : "Restore Real Time (NTP)").props.onClick;
    let pending;
    await act(async () => { pending = click(); });
    await app.unmount();
    assert.equal(app.timers.size, 0);
    await act(async () => {
      operation.resolve({ ...initialStatus, epoch: initialStatus.epoch + 3600 });
      await pending;
    });
    assert.equal(app.timers.size, 0);
    assert.equal(app.toasts.length, 0);
  });
}

for (const rejected of [false, true]) {
  test(`a late ${rejected ? "rejected request" : "failure response"} after unmount shows no error toast`, async t => {
    const operation = deferred();
    const app = await mount(t, async name => name === "shift_time" ? operation.promise : initialStatus);
    let pending;
    await act(async () => { pending = app.quick("+1h").props.onClick(); });
    await app.unmount();
    await act(async () => {
      if (rejected) operation.reject(new Error("request failed"));
      else operation.resolve({ ...initialStatus, ok: false, error: "time change failed" });
      await pending;
    });
    assert.equal(app.toasts.length, 0);
    assert.equal(app.timers.size, 0);
  });
}

test("unmount cancels a pending merged shift toast", async t => {
  const app = await mount(t);
  await act(async () => app.quick("+1h").props.onClick());
  assert.equal(app.toasts.length, 0);
  const timeout = [...app.timers.values()].find(timer => timer.delay === 1500);
  assert.ok(timeout);
  await app.unmount();
  assert.equal(app.timers.size, 0);
  // A callback already queued by the host must also be harmless after cleanup.
  await act(async () => timeout.fn());
  assert.equal(app.toasts.length, 0);
});

test("calendar changes, clock ticks, and submission keep the selected date", async t => {
  let sent;
  const app = await mount(t, async (name, args) => {
    if (name === "set_time") sent = args[0];
    return { ...initialStatus, epoch: sent ?? initialStatus.epoch };
  });
  await app.slide(0, 2028);
  await app.slide(1, 2);
  assert.equal(app.sliders()[2].props.value, 29);
  await app.slide(0, 2027);
  assert.equal(app.sliders()[2].props.value, 28);
  await app.slide(2, 21);
  await app.slide(3, 23);
  await app.slide(4, 59);
  const ranges = app.sliders().map(field => [field.props.min, field.props.max]);
  await app.tick(1000);
  app.sliders().forEach((field, index) => assert.deepStrictEqual([field.props.min, field.props.max], ranges[index]));
  await act(async () => app.button("Set to This Time").props.onClick());
  assert.equal(sent, Math.floor(new Date(2027, 1, 21, 23, 59).getTime() / 1000));
  assert.equal(app.sliders()[4].props.value, 59);
});
