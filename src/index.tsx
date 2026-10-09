import {
  ButtonItem,
  DialogButton,
  Dropdown,
  Focusable,
  PanelSection,
  PanelSectionRow,
  staticClasses,
} from "@decky/ui";
import { callable, definePlugin, toaster, useQuickAccessVisible } from "@decky/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { FaClock } from "react-icons/fa";
import type { DropdownOption } from "@decky/ui";
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

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmt(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function numOptions(from: number, to: number): DropdownOption[] {
  return Array.from({ length: to - from + 1 }, (_, i) => ({
    data: from + i,
    label: from + i > 99 ? String(from + i) : pad(from + i),
  }));
}

function Content() {
  const visible = useQuickAccessVisible();
  const t = useMemo(() => makeT(detectLang()), []);
  // computed once: anchor for the year dropdown window (±5 years)
  const yearBase = useMemo(() => new Date().getFullYear(), []);

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

  const quickOffsets = useMemo(
    () => [
      { label: `+30${t("unit.min")}`, delta: 30 * MINUTE },
      { label: `-30${t("unit.min")}`, delta: -30 * MINUTE },
      { label: `+1${t("unit.hour")}`, delta: HOUR },
      { label: `-1${t("unit.hour")}`, delta: -HOUR },
    ],
    [t],
  );

  const [epoch, setEpoch] = useState<number | undefined>();
  const [ntpEnabled, setNtpEnabled] = useState<boolean | undefined>();
  const [ntpSynced, setNtpSynced] = useState<boolean | undefined>();
  const [timezone, setTimezone] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // custom datetime picker state, defaults to current time once loaded
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [day, setDay] = useState(new Date().getDate());
  const [hour, setHour] = useState(new Date().getHours());
  const [minute, setMinute] = useState(new Date().getMinutes());
  const initialized = useRef(false);

  const syncToNow = (nowEpoch: number) => {
    const d = new Date(nowEpoch * 1000);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
    setDay(d.getDate());
    setHour(d.getHours());
    setMinute(d.getMinutes());
  };

  const applyStatus = (res: TimeStatus) => {
    if (res.ok && res.epoch !== undefined) {
      setEpoch(res.epoch);
      setNtpEnabled(res.ntp_enabled);
      setNtpSynced(res.ntp_synced);
      setTimezone(res.timezone);
      if (!initialized.current) {
        initialized.current = true;
        syncToNow(res.epoch);
      }
    } else {
      toaster.toast({ title: t("toast.failure"), body: res.error ?? t("toast.unknownError") });
    }
  };

  useEffect(() => {
    if (!visible) return;
    let active = true;
    (async () => {
      try {
        const res = await getStatus();
        if (active) applyStatus(res);
      } catch (e) {
        if (active) {
          toaster.toast({ title: t("toast.failure"), body: String(e) });
        }
      }
    })();
    const timer = setInterval(() => {
      setEpoch((e) => (e === undefined ? e : e + 1));
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [visible]);

  const run = async (fn: () => Promise<TimeStatus>, successMsg: (res: TimeStatus) => string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fn();
      applyStatus(res);
      if (res.ok) {
        toaster.toast({ title: "Time Changer", body: successMsg(res) });
      }
    } catch (e) {
      toaster.toast({ title: t("toast.failure"), body: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const onQuickOffset = (delta: number) =>
    run(
      () => shiftTime(delta),
      (res) => t("toast.shifted", { offset: fmtOffset(delta), time: fmt(res.epoch ?? 0) }),
    );

  // clamp day when year/month changes across months of different length
  const daysInMonth = useMemo(() => new Date(year, month, 0).getDate(), [year, month]);
  const effDay = Math.min(day, daysInMonth);

  // Reuse option lists while the current-time display ticks. Only the day
  // options need to change when the selected month's length changes.
  const yearOpts = useMemo(() => numOptions(yearBase - 5, yearBase + 5), [yearBase]);
  const monthOpts = useMemo(() => numOptions(1, 12), []);
  const dayOpts = useMemo(() => numOptions(1, daysInMonth), [daysInMonth]);
  const hourOpts = useMemo(() => numOptions(0, 23), []);
  const minuteOpts = useMemo(() => numOptions(0, 59), []);

  const onSetCustom = () => {
    const target = new Date(year, month - 1, effDay, hour, minute);
    const targetEpoch = Math.floor(target.getTime() / 1000);
    run(
      () => setTime(targetEpoch),
      (res) => t("toast.set", { time: fmt(res.epoch ?? 0) }),
    );
  };

  const onRestore = () => run(restoreTime, () => t("toast.restored"));

  return (
    <div>
      <PanelSection title={t("panel.current")}>
        <PanelSectionRow>
          <div className={staticClasses.Text} style={{ fontSize: "1.1em", textAlign: "center", paddingTop: "8px", paddingBottom: "4px" }}>
            {epoch !== undefined ? fmt(epoch) : t("panel.current.loading")}
          </div>
          <div style={{ textAlign: "center", opacity: 0.7, fontSize: "0.85em" }}>
            {ntpSynced === undefined
              ? ""
              : ntpSynced
                ? t("panel.current.ntpSynced")
                : ntpEnabled
                  ? t("panel.current.ntpEnabled")
                  : t("panel.current.manual", { timezone: timezone ?? "" })}
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
          <Focusable style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <Focusable style={{ display: "flex", flexDirection: "row", gap: "8px", justifyContent: "center" }}>
              <Dropdown rgOptions={yearOpts} selectedOption={year} onChange={(o) => setYear(o.data)} disabled={busy} menuLabel={t("date.year")} />
              <Dropdown rgOptions={monthOpts} selectedOption={month} onChange={(o) => setMonth(o.data)} disabled={busy} menuLabel={t("date.month")} />
              <Dropdown rgOptions={dayOpts} selectedOption={effDay} onChange={(o) => setDay(o.data)} disabled={busy} menuLabel={t("date.day")} />
            </Focusable>
            <Focusable style={{ display: "flex", flexDirection: "row", gap: "8px", justifyContent: "center" }}>
              <Dropdown rgOptions={hourOpts} selectedOption={hour} onChange={(o) => setHour(o.data)} disabled={busy} menuLabel={t("date.hour")} />
              <Dropdown rgOptions={minuteOpts} selectedOption={minute} onChange={(o) => setMinute(o.data)} disabled={busy} menuLabel={t("date.minute")} />
            </Focusable>
          </Focusable>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy} onClick={onSetCustom}>
            {t("action.set")}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title={t("panel.restore")}>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy} onClick={onRestore}>
            {t("action.restore")}
          </ButtonItem>
          <div style={{ textAlign: "center", opacity: 0.7, fontSize: "0.85em", paddingTop: "4px" }}>
            {t("hint.restore")}
          </div>
        </PanelSectionRow>
      </PanelSection>
    </div>
  );
}

export default definePlugin(() => {
  return {
    name: "Time Changer",
    titleView: <div className={staticClasses.Title}>Time Changer</div>,
    content: <Content />,
    // Steam menus can temporarily hide the QAM. Keep picker state mounted so
    // their selection callbacks do not target an already unmounted Content.
    alwaysRender: true,
    icon: <FaClock />,
    onDismount() {},
  };
});
