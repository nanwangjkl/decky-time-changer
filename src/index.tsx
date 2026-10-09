import {
  ButtonItem,
  DialogButton,
  Focusable,
  PanelSection,
  PanelSectionRow,
  SliderField,
  staticClasses,
  TextField,
} from "@decky/ui";
import { callable, definePlugin, toaster } from "@decky/api";
import { useEffect, useState } from "react";
import { FaClock } from "react-icons/fa";

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

const HOUR = 3600;
const DAY = 24 * HOUR;

const QUICK_OFFSETS: Array<{ label: string; delta: number }> = [
  { label: "+1小时", delta: HOUR },
  { label: "+6小时", delta: 6 * HOUR },
  { label: "+12小时", delta: 12 * HOUR },
  { label: "+1天", delta: DAY },
  { label: "+7天", delta: 7 * DAY },
  { label: "-1小时", delta: -HOUR },
  { label: "-1天", delta: -DAY },
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
  const days = Math.floor(abs / DAY);
  const hours = (abs % DAY) / HOUR;
  if (days > 0 && hours > 0) return `${sign}${days}天${hours}小时`;
  if (days > 0) return `${sign}${days}天`;
  return `${sign}${hours}小时`;
}

function Content() {
  const [epoch, setEpoch] = useState<number | undefined>();
  const [ntpEnabled, setNtpEnabled] = useState<boolean | undefined>();
  const [ntpSynced, setNtpSynced] = useState<boolean | undefined>();
  const [timezone, setTimezone] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [offsetHours, setOffsetHours] = useState(0);
  const [customText, setCustomText] = useState("");

  const applyStatus = (res: TimeStatus) => {
    if (res.ok && res.epoch !== undefined) {
      setEpoch(res.epoch);
      setNtpEnabled(res.ntp_enabled);
      setNtpSynced(res.ntp_synced);
      setTimezone(res.timezone);
    } else {
      toaster.toast({ title: "操作失败", body: res.error ?? "未知错误" });
    }
  };

  const refresh = async () => {
    const res = await getStatus();
    applyStatus(res);
  };

  useEffect(() => {
    refresh();
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
        toastOk(successMsg(res));
      }
    } catch (e) {
      toaster.toast({ title: "操作失败", body: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const toastOk = (msg: string) => toaster.toast({ title: "Time Changer", body: msg });

  const onQuickOffset = (delta: number) =>
    run(
      () => shiftTime(delta),
      (res) => `时间已调整 ${fmtOffset(delta)} → ${fmt(res.epoch ?? 0)}`,
    );

  const onApplyOffset = () =>
    run(
      () => shiftTime(offsetHours * HOUR),
      (res) => `时间已调整 ${fmtOffset(offsetHours * HOUR)} → ${fmt(res.epoch ?? 0)}`,
    );

  const onSetCustom = () => {
    // "YYYY-MM-DD HH:MM" parsed in the Deck's local timezone
    const parsed = new Date(customText.trim().replace(" ", "T"));
    if (Number.isNaN(parsed.getTime())) {
      toaster.toast({ title: "时间格式错误", body: "请输入 YYYY-MM-DD HH:MM，例如 2026-10-11 09:30" });
      return;
    }
    run(
      () => setTime(Math.floor(parsed.getTime() / 1000)),
      (res) => `时间已设为 ${fmt(res.epoch ?? 0)}`,
    );
  };

  const onRestore = () =>
    run(restoreTime, () => "NTP 已开启，联网后将自动校准回真实时间");

  const previewEpoch = epoch !== undefined ? epoch + offsetHours * HOUR : undefined;

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
              <DialogButton key={delta} style={{ minWidth: "100px", flex: "1 1 30%" }} disabled={busy} onClick={() => onQuickOffset(delta)}>
                {label}
              </DialogButton>
            ))}
          </Focusable>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="按偏移量调整">
        <PanelSectionRow>
          <SliderField
            label={`偏移 ${fmtOffset(offsetHours * HOUR)}`}
            description={previewEpoch !== undefined && offsetHours !== 0 ? `目标时间：${fmt(previewEpoch)}` : undefined}
            value={offsetHours}
            min={-30 * 24}
            max={30 * 24}
            step={1}
            onChange={setOffsetHours}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy || offsetHours === 0} onClick={onApplyOffset}>
            应用偏移
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="自定义时间">
        <PanelSectionRow>
          <TextField
            label="目标时间"
            description="格式 YYYY-MM-DD HH:MM（本机时区），如 2026-10-11 09:30"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy || !customText.trim()} onClick={onSetCustom}>
            设置为此时间
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
