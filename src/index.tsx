import {
  ButtonItem,
  DialogButton,
  Focusable,
  PanelSection,
  PanelSectionRow,
  SliderField,
  staticClasses,
} from "@decky/ui";
import { callable, definePlugin, toaster, useQuickAccessVisible } from "@decky/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaClock } from "react-icons/fa";
import { detectLang, makeT } from "./translations";

interface TimeStatus {
  ok: boolean;
  error?: string;
  epoch?: number;
  ntp_enabled?: boolean;
  ntp_synced?: boolean;
  timezone?: string;
}

const getStatus = callable<[], TimeStatus>("get_status");
const setTime = callable<[epoch: number], TimeStatus>("set_time");
const shiftTime = callable<[delta: number], TimeStatus>("shift_time");
const restoreTime = callable<[], TimeStatus>("restore_time");

const MINUTE = 60;
const HOUR = 3600;
const DAY = 24 * HOUR;
const STATUS_INTERVAL = 5000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmt(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Steam toasts clip long bodies; keep the informative head visible.
const short = (s: string) => (s.length > 80 ? s.slice(0, 77) + "…" : s);

function Content() {
  const visible = useQuickAccessVisible();
  const t = useMemo(() => makeT(detectLang()), []);

  const fmtOffset = (delta: number): string => {
    const sign = delta >= 0 ? "+" : "-";
    const abs = Math.abs(delta);
    const days = Math.floor(abs / 86400);
    const hours = Math.floor((abs % 86400) / 3600);
    const minutes = Math.floor((abs % 3600) / 60);
    const parts: string[] = [];
    if (days > 0) parts.push(`${days}${t("unit.day")}`);
    if (hours > 0) parts.push(`${hours}${t("unit.hour")}`);
    if (minutes > 0) parts.push(`${minutes}${t("unit.min")}`);
    return sign + (parts.join(" ") || `0${t("unit.min")}`);
  };

  // minus on the left, plus on the right — pairs wrap into two columns
  const quickOffsets = useMemo(
    () => [
      { label: `-30${t("unit.min")}`, delta: -30 * MINUTE },
      { label: `+30${t("unit.min")}`, delta: 30 * MINUTE },
      { label: `-1${t("unit.hour")}`, delta: -HOUR },
      { label: `+1${t("unit.hour")}`, delta: HOUR },
      { label: `-1${t("unit.day")}`, delta: -DAY },
      { label: `+1${t("unit.day")}`, delta: DAY },
    ],
    [t],
  );

  const [epoch, setEpoch] = useState<number | undefined>();
  const [ntpEnabled, setNtpEnabled] = useState<boolean | undefined>();
  const [ntpSynced, setNtpSynced] = useState<boolean | undefined>();
  const [timezone, setTimezone] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const operationInFlight = useRef(false);
  const statusVersion = useRef(0);

  // custom datetime picker state, defaults to current time once loaded
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [day, setDay] = useState(new Date().getDate());
  const [hour, setHour] = useState(new Date().getHours());
  const [minute, setMinute] = useState(new Date().getMinutes());
  const initialized = useRef(false);

  // keep the day valid when year/month changes (31 Jan -> February etc.)
  const changeYear = useCallback((v: number) => {
    setYear(v);
    setDay((d) => Math.min(d, new Date(v, month, 0).getDate()));
  }, [month]);
  const changeMonth = useCallback((v: number) => {
    setMonth(v);
    setDay((d) => Math.min(d, new Date(year, v, 0).getDate()));
  }, [year]);

  const syncToNow = useCallback((nowEpoch: number) => {
    const d = new Date(nowEpoch * 1000);
    // the system clock may be skewed outside the year window; clamp so the
    // dropdown can always represent the selected value
    setYear(Math.min(Math.max(d.getFullYear(), 2003), 2034));
    setMonth(d.getMonth() + 1);
    setDay(d.getDate());
    setHour(d.getHours());
    setMinute(d.getMinutes());
  }, []);

  const applyStatus = useCallback((res: TimeStatus, reportError = true) => {
    // Failed operations may still include the actual state after NTP rollback.
    if (res.epoch !== undefined) {
      setEpoch(res.epoch);
      setNtpEnabled(res.ntp_enabled);
      setNtpSynced(res.ntp_synced);
      setTimezone(res.timezone);
      if (!initialized.current) {
        initialized.current = true;
        syncToNow(res.epoch);
      }
    }
    if (!res.ok && reportError) {
      toaster.toast({ title: t("toast.failure"), body: short(res.error ?? t("toast.unknownError")) });
    }
  }, [syncToNow, t]);

  useEffect(() => {
    if (!visible || busy) return;
    let active = true;
    let inFlight = false;
    let errorReported = false;
    const refresh = async () => {
      if (inFlight || operationInFlight.current) return;
      inFlight = true;
      const version = statusVersion.current;
      try {
        const res = await getStatus();
        if (active && version === statusVersion.current) {
          applyStatus(res, !errorReported);
          errorReported = !res.ok;
        }
      } catch (e) {
        if (active && version === statusVersion.current && !errorReported) {
          toaster.toast({ title: t("toast.failure"), body: String(e) });
          errorReported = true;
        }
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    // NTP can adjust the clock after restore_time has already returned.
    const timer = setInterval(refresh, STATUS_INTERVAL);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [visible, busy, applyStatus, t]);

  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => {
      setEpoch((e) => (e === undefined ? e : e + 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [visible]);

  const toastOk = (body: string) => toaster.toast({ title: "Time Changer", body });

  const run = async (fn: () => Promise<TimeStatus>, onSuccess: (res: TimeStatus) => void) => {
    if (!mounted.current || operationInFlight.current) return;
    operationInFlight.current = true;
    // Ignore reads started before this operation, even if responses arrive late.
    statusVersion.current++;
    setBusy(true);
    try {
      const res = await fn();
      if (!mounted.current) return;
      applyStatus(res);
      if (res.ok) onSuccess(res);
    } catch (e) {
      if (mounted.current) {
        toaster.toast({ title: t("toast.failure"), body: short(String(e)) });
      }
    } finally {
      statusVersion.current++;
      operationInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  // Rapid consecutive shifts merge into one toast with the accumulated offset.
  const pendingShift = useRef<{ timer: ReturnType<typeof setTimeout>; delta: number; epoch: number } | null>(null);

  const settleShiftToast = () => {
    const pending = pendingShift.current;
    if (!mounted.current || !pending) return;
    clearTimeout(pending.timer);
    pendingShift.current = null;
    toastOk(t("toast.shifted", { offset: fmtOffset(pending.delta), time: fmt(pending.epoch) }));
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pendingShift.current) clearTimeout(pendingShift.current.timer);
      pendingShift.current = null;
    };
  }, []);

  const onQuickOffset = (delta: number) =>
    run(() => shiftTime(delta), (res) => {
      if (pendingShift.current) clearTimeout(pendingShift.current.timer);
      const accumulated = (pendingShift.current?.delta ?? 0) + delta;
      pendingShift.current = {
        delta: accumulated,
        epoch: res.epoch ?? 0,
        timer: setTimeout(settleShiftToast, 1500),
      };
    });

  // clamp day when year/month changes across months of different length
  const daysInMonth = useMemo(() => new Date(year, month, 0).getDate(), [year, month]);
  const effDay = Math.min(day, daysInMonth);

  // Reuse option lists while the current-time display ticks. Only the day
  // options need to change when the selected month's length changes.
  const pickerDisabled = busy || epoch === undefined;

  const onSetCustom = () => {
    if (pickerDisabled) return;
    const target = new Date(year, month - 1, effDay, hour, minute);
    const targetEpoch = Math.floor(target.getTime() / 1000);
    run(
      () => {
        // Settle the previous operation before changing the clock or NTP state.
        settleShiftToast();
        return setTime(targetEpoch);
      },
      (res) => toastOk(t("toast.set", { time: fmt(res.epoch ?? 0) })),
    );
  };

  const onRestore = () =>
    run(
      () => {
        settleShiftToast();
        return restoreTime();
      },
      (res) => {
        // End the custom-time session: the picker draft resets to the system
        // time at the moment of restore. Deliberately not tied to the later
        // NTP resync — sliders must never mutate under the user asynchronously.
        syncToNow(res.epoch ?? 0);
        toastOk(t("toast.restored"));
      },
    );

  return (
    <div>
      {/* sticky clock header — pinned while the panel scrolls */}
      <div
        style={{
          position: "sticky",
          top: 40,
          zIndex: 10,
          background: "rgba(14, 20, 28, 0.85)",
          backdropFilter: "blur(4px)",
          borderBottom: "1px solid rgba(255, 255, 255, 0.12)",
          paddingTop: "10px",
          paddingBottom: "6px",
          marginBottom: "14px",
          // Manual mode remains a warning even if the kernel retains its sync
          // flag; also warn while NTP is enabled but has not synchronized yet.
          color: ntpEnabled === false || ntpSynced === false ? "#f2b232" : undefined,
        }}
      >
        <div className={staticClasses.Text} style={{ fontSize: "1.1em", textAlign: "center" }}>
          {epoch !== undefined ? fmt(epoch) : t("panel.current.loading")}
        </div>
        <div style={{ textAlign: "center", opacity: 0.7, fontSize: "0.85em" }}>
          {ntpEnabled === undefined
            ? ""
            : !ntpEnabled
              ? t("panel.current.manual", { timezone: timezone ?? "" })
              : ntpSynced
                ? t("panel.current.ntpSynced")
                : t("panel.current.ntpEnabled")}
        </div>
      </div>

      <PanelSection title={t("panel.restore")}>
        <PanelSectionRow>
          <ButtonItem layout="below" highlightOnFocus={false} disabled={busy} onClick={onRestore}>
            {t("action.restore")}
          </ButtonItem>
          <div style={{ textAlign: "center", opacity: 0.7, fontSize: "0.85em", paddingTop: "4px" }}>
            {t("hint.restore")}
          </div>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={t("panel.offset")}>
        <PanelSectionRow>
          <Focusable style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: "8px", justifyContent: "center" }}>
            {quickOffsets.map(({ label, delta }) => (
              <DialogButton key={delta} style={{ minWidth: "120px", flex: "1 1 40%" }} disabled={busy} onClick={() => onQuickOffset(delta)}>
                {label}
              </DialogButton>
            ))}
          </Focusable>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={t("panel.custom")}>
        <PanelSectionRow>
          <SliderField label={t("date.year")} value={year} min={2003} max={2034} step={1} showValue disabled={pickerDisabled} onChange={changeYear} />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField label={t("date.month")} value={month} min={1} max={12} step={1} showValue disabled={pickerDisabled} onChange={changeMonth} />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField label={t("date.day")} value={effDay} min={1} max={daysInMonth} step={1} showValue disabled={pickerDisabled} onChange={setDay} />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField label={t("date.hour")} value={hour} min={0} max={23} step={1} showValue disabled={pickerDisabled} onChange={setHour} />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField label={t("date.minute")} value={minute} min={0} max={59} step={1} showValue disabled={pickerDisabled} onChange={setMinute} />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" highlightOnFocus={false} disabled={pickerDisabled} onClick={onSetCustom}>
            {t("action.set")}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </div>
  );
}

export default definePlugin(() => {
  return {
    name: "Time Changer",
    content: <Content />,
    // Steam menus can temporarily hide the QAM. Keep picker state mounted so
    // their selection callbacks do not target an already unmounted Content.
    alwaysRender: true,
    icon: <FaClock />,
    onDismount() {},
  };
});
