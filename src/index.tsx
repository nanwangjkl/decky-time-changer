import {
  ButtonItem,
  DialogButton,
  Dropdown,
  Focusable,
  PanelSection,
  PanelSectionRow,
  staticClasses,
} from "@decky/ui";
import { callable, definePlugin, toaster } from "@decky/api";
import { useEffect, useRef, useState } from "react";
import { FaClock } from "react-icons/fa";
import type { DropdownOption } from "@decky/ui";

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

const QUICK_OFFSETS: Array<{ label: string; delta: number }> = [
  { label: "+30分钟", delta: 30 * MINUTE },
  { label: "-30分钟", delta: -30 * MINUTE },
  { label: "+1小时", delta: HOUR },
  { label: "-1小时", delta: -HOUR },
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmt(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtOffset(delta: number): string {
  const sign = delta >= 0 ? "+" : "-";
  const abs = Math.abs(delta);
  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  if (days > 0) return `${sign}${days}天${hours}小时`;
  if (hours > 0) return `${sign}${hours}小时${minutes ? minutes + "分钟" : ""}`;
  return `${sign}${minutes}分钟`;
}

function numOptions(from: number, to: number): DropdownOption[] {
  return Array.from({ length: to - from + 1 }, (_, i) => ({
    data: from + i,
    label: from + i > 99 ? String(from + i) : pad(from + i),
  }));
}

function Content() {
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
      toaster.toast({ title: "操作失败", body: res.error ?? "未知错误" });
    }
  };

  useEffect(() => {
    (async () => {
      const res = await getStatus();
      applyStatus(res);
    })();
    const timer = setInterval(() => {
      setEpoch((e) => (e === undefined ? e : e + 1));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

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
      toaster.toast({ title: "操作失败", body: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const onQuickOffset = (delta: number) =>
    run(
      () => shiftTime(delta),
      (res) => `时间已调整 ${fmtOffset(delta)} → ${fmt(res.epoch ?? 0)}`,
    );

  // clamp day when year/month changes across months of different length
  const daysInMonth = new Date(year, month, 0).getDate();
  const effDay = Math.min(day, daysInMonth);

  const onSetCustom = () => {
    const target = new Date(year, month - 1, effDay, hour, minute);
    const targetEpoch = Math.floor(target.getTime() / 1000);
    run(
      () => setTime(targetEpoch),
      (res) => `时间已设为 ${fmt(res.epoch ?? 0)}`,
    );
  };

  const onRestore = () =>
    run(restoreTime, () => "NTP 已开启，联网后将自动校准回真实时间");

  return (
    <div>
      <PanelSection title="当前系统时间">
        <PanelSectionRow>
          <div className={staticClasses.Text} style={{ fontSize: "1.1em", textAlign: "center", paddingTop: "8px", paddingBottom: "4px" }}>
            {epoch !== undefined ? fmt(epoch) : "读取中..."}
          </div>
          <div style={{ textAlign: "center", opacity: 0.7, fontSize: "0.85em" }}>
            {ntpSynced === undefined
              ? ""
              : ntpSynced
                ? "NTP 自动同步中"
                : ntpEnabled
                  ? "NTP 已开启（未同步）"
                  : `手动时间 · 时区 ${timezone ?? ""}`}
          </div>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="快捷偏移">
        <PanelSectionRow>
          <Focusable style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: "8px", justifyContent: "center" }}>
            {QUICK_OFFSETS.map(({ label, delta }) => (
              <DialogButton key={delta} style={{ minWidth: "120px", flex: "1 1 40%" }} disabled={busy} onClick={() => onQuickOffset(delta)}>
                {label}
              </DialogButton>
            ))}
          </Focusable>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="自定义时间">
        <PanelSectionRow>
          <Focusable style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <Focusable style={{ display: "flex", flexDirection: "row", gap: "8px", justifyContent: "center" }}>
              <Dropdown rgOptions={numOptions(year - 5, year + 5)} selectedOption={year} onChange={(o) => setYear(o.data)} disabled={busy} menuLabel="年份" />
              <Dropdown rgOptions={numOptions(1, 12)} selectedOption={month} onChange={(o) => setMonth(o.data)} disabled={busy} menuLabel="月份" />
              <Dropdown rgOptions={numOptions(1, daysInMonth)} selectedOption={effDay} onChange={(o) => setDay(o.data)} disabled={busy} menuLabel="日期" />
            </Focusable>
            <Focusable style={{ display: "flex", flexDirection: "row", gap: "8px", justifyContent: "center" }}>
              <Dropdown rgOptions={numOptions(0, 23)} selectedOption={hour} onChange={(o) => setHour(o.data)} disabled={busy} menuLabel="小时" />
              <Dropdown rgOptions={numOptions(0, 59)} selectedOption={minute} onChange={(o) => setMinute(o.data)} disabled={busy} menuLabel="分钟" />
            </Focusable>
          </Focusable>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy} onClick={onSetCustom}>
            设置为此时间
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy} onClick={() => epoch !== undefined && syncToNow(epoch)}>
            重置为当前时间
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="恢复">
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy} onClick={onRestore}>
            恢复真实时间（NTP 自动校准）
          </ButtonItem>
          <div style={{ textAlign: "center", opacity: 0.7, fontSize: "0.85em", paddingTop: "4px" }}>
            恢复需联网。时间偏差过大时 Steam 联网功能可能异常，属正常现象。
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
    icon: <FaClock />,
    onDismount() {},
  };
});
