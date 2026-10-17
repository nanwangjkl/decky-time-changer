// Minimal self-contained i18n. The Steam client exposes its locale via
// window.LocalizationManager.m_rgLocalesToUse (e.g. "english", "schinese");
// we match it against our bundled dictionaries and fall back to English.

export type Lang = "en" | "zh-cn";

export const STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    "panel.current": "Current System Time",
    "panel.current.loading": "Loading...",
    "panel.current.ntpSynced": "NTP auto-sync active",
    "panel.current.ntpEnabled": "NTP enabled (not synced)",
    "panel.current.manual": "Manual time · {timezone}",
    "panel.offset": "Quick Offset",
    "panel.custom": "Custom Date & Time",
    "panel.restore": "Restore",
    "action.set": "Set to This Time",
    "action.restore": "Restore Real Time (NTP)",
    "hint.restore": "Restore needs network. While the clock is skewed, Steam's online features may fail TLS checks — this is expected.",
    "unit.min": "min",
    "unit.hour": "h",
    "unit.day": "d",
    "date.year": "Year",
    "date.month": "Month",
    "date.day": "Day",
    "date.hour": "Hour",
    "date.minute": "Minute",
    "toast.failure": "Operation failed",
    "toast.unknownError": "Unknown error",
    "toast.shifted": "Time shifted {offset} → {time} (NTP off until restored)",
    "toast.set": "Time set to {time} (NTP off until restored)",
    "toast.restored": "NTP re-enabled. It will resync to real time once online.",
  },
  "zh-cn": {
    "panel.current": "当前系统时间",
    "panel.current.loading": "读取中...",
    "panel.current.ntpSynced": "NTP 自动同步中",
    "panel.current.ntpEnabled": "NTP 已开启（未同步）",
    "panel.current.manual": "手动时间 · 时区 {timezone}",
    "panel.offset": "快捷偏移",
    "panel.custom": "自定义时间",
    "panel.restore": "恢复",
    "action.set": "设置为此时间",
    "action.restore": "恢复真实时间（NTP 自动校准）",
    "hint.restore": "恢复需联网。时间偏差过大时 Steam 联网功能可能异常，属正常现象。",
    "unit.min": "分钟",
    "unit.hour": "小时",
    "unit.day": "天",
    "date.year": "年份",
    "date.month": "月份",
    "date.day": "日期",
    "date.hour": "小时",
    "date.minute": "分钟",
    "toast.failure": "操作失败",
    "toast.unknownError": "未知错误",
    "toast.shifted": "时间已调整 {offset} → {time}（NTP 已关闭，恢复前不自动同步）",
    "toast.set": "时间已设为 {time}（NTP 已关闭，恢复前不自动同步）",
    "toast.restored": "NTP 已开启，联网后将自动校准回真实时间。",
  },
};

// window.LocalizationManager is already declared globally by @decky/ui
export function detectLang(): Lang {
  try {
    const locales = window.LocalizationManager?.m_rgLocalesToUse ?? [];
    if (locales.some((l) => l.toLowerCase().includes("chinese") || l.toLowerCase().includes("zh"))) {
      return "zh-cn";
    }
  } catch {
    // fall through to English
  }
  return "en";
}

export type Translator = (key: string, vars?: Record<string, string>) => string;

export function makeT(lang: Lang): Translator {
  const dict = STRINGS[lang] ?? STRINGS.en;
  return (key, vars) => {
    let s = dict[key] ?? STRINGS.en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replace(`{${k}}`, v);
      }
    }
    return s;
  };
}
