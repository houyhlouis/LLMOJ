import React from "react";
import { observer } from "mobx-react";
import { appState } from "@/appState";
import style from "./DifficultyRating.module.less";

// This site's approximate, non-overlapping bands. Luogu's June 2026 ranges overlap:
// https://help.luogu.com.cn/release-note (2000–2400 / 2300–2700 / 2700–3100).
// Color order: https://help.luogu.com.cn/manual/luogu/problem/difficulty
const bands = [
  { upper: 900, color: "red", zh: "入门", en: "Red" },
  { upper: 1200, color: "orange", zh: "普及-", en: "Orange" },
  { upper: 1600, color: "yellow", zh: "普及", en: "Yellow" },
  { upper: 2000, color: "green", zh: "普及+/提高-", en: "Green" },
  { upper: 2400, color: "cyan", zh: "提高", en: "Cyan" },
  { upper: 2700, color: "blue", zh: "提高+/省选-", en: "Blue" },
  { upper: 3100, color: "purple", zh: "省选/NOI-", en: "Purple" },
  { upper: Infinity, color: "black", zh: "NOI/NOI+/CTS", en: "Black" }
];
export default observer(function DifficultyRating({ value }: { value?: number | null }) {
  if (value == null) return <span>—</span>;
  const band = bands.find(band => value < band.upper);
  const title =
    appState.locale === "zh_CN"
      ? `${band.zh} · 本站 CF 难度近似对照`
      : `${band.en} · Approximate CF difficulty mapping`;
  return (
    <strong className={style[band.color]} title={title}>
      {value}
    </strong>
  );
});
