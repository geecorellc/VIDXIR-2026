"use client";

/**
 * Search-demand area chart — the prototype's recharts `AreaChart`, same colours
 * and axis treatment.
 *
 * With no research run yet there is no series to draw, so instead of animating a
 * placeholder curve the card says what is missing (§42). A fake trend line is
 * worse than an empty state: it invites a decision based on nothing.
 */
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { color } from "@/lib/design/tokens";

export interface DemandChartProps {
  series: Array<{ label: string; value: number }> | null;
}

export function DemandChart({ series }: DemandChartProps) {
  if (!series || series.length === 0) {
    return (
      <div
        style={{
          height: 200,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          textAlign: "center",
          border: `1px dashed ${color.borderLight}`,
          borderRadius: 8,
          padding: 20,
        }}
      >
        <span style={{ fontSize: 13, color: color.textDim }}>
          No demand data yet.
        </span>
        <span style={{ fontSize: 12, color: color.textFaint, maxWidth: 300, lineHeight: 1.55 }}>
          Run research on a connected channel and Tally will chart real search
          interest for your niche here.
        </span>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={series}>
        <defs>
          <linearGradient id="tally-demand" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color.accent} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color.accent} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={color.subtle} vertical={false} />
        <XAxis
          dataKey="label"
          stroke={color.textFaint}
          fontSize={11}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          stroke={color.textFaint}
          fontSize={11}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          contentStyle={{
            background: color.card,
            border: `1px solid ${color.border}`,
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: color.textDim }}
        />
        <Area
          type="monotone"
          dataKey="value"
          name="Interest"
          stroke={color.accent}
          fill="url(#tally-demand)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
