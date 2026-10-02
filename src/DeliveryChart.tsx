import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LabelList,
} from "recharts";
import type { Counts } from "../shared/types";
type Row = Counts & { id: string; name: string };
export default function DeliveryChart({
  rows,
  series,
  onDetail,
}: {
  rows: Row[];
  series: readonly { key: keyof Counts; label: string; color: string }[];
  onDetail: (detail: { studentId: string; bucket?: string }) => void;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={rows}
        margin={{ top: 35, right: 20, bottom: 25, left: 0 }}
        barGap={8}
      >
        <CartesianGrid vertical={false} stroke="#e8e3db" />
        <XAxis
          dataKey="name"
          tickLine={false}
          axisLine={{ stroke: "#777" }}
          tick={{ fill: "#202522", fontSize: 14 }}
          interval={0}
        />
        <YAxis
          allowDecimals={false}
          tickLine={false}
          axisLine={false}
          width={45}
          label={{ value: "Tasks", angle: -90, position: "insideLeft" }}
        />
        <Tooltip cursor={{ fill: "#f4f0e8" }} />
        {series.map((s) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={s.color}
            maxBarSize={64}
            onClick={(data) => {
              const payload = (data as unknown as { payload?: { id: string } })
                .payload;
              if (payload) onDetail({ studentId: payload.id, bucket: s.key });
            }}
          >
            <LabelList dataKey={s.key} position="top" fill="#151b17" />
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
