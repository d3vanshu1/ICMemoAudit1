import React from "react";
import {
  LineChart as LineChartComponent,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  LabelList,
} from "recharts";

import {
  registerComponent,
  Prop,
  Section,
  PropsCategory,
} from "@superblocksteam/library";

import { cn } from "@/lib/utils";

import type { ChartConfig } from "./chart";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  sanitizeForCssVar,
  fixColorFormat,
  createKeyMapping,
} from "./chart";

type ComponentProps = Omit<
  React.ComponentPropsWithoutRef<typeof ChartContainer>,
  "children" | "config"
> & {
  data?: any[];
  xAxisKey?: string;
  categories?: string[];
  seriesLabels?: Record<string, string>;
  colors?: string[];
  gridStyle?: "solid" | "dashed" | "hidden";
  showXAxis?: boolean;
  showYAxis?: boolean;
  showTooltip?: boolean;
  showLegend?: boolean;
  lineType?:
    | "monotone"
    | "linear"
    | "step"
    | "bump"
    | "basis"
    | "stepBefore"
    | "stepAfter"
    | "natural";
  strokeWidth?: number;
  connectNulls?: boolean;
  enableAnimation?: boolean;
  showDots?: boolean;
  showPointLabels?: boolean;
  onDataClick?: (data: any) => void;
};

const LineChart = ({ className, ...props }: ComponentProps) => {
  const chartConfig: ChartConfig = React.useMemo(() => {
    const effectiveCategories =
      props.categories && props.categories.length > 0
        ? props.categories
        : props.data && props.data.length > 0
          ? Object.keys(props.data[0]).filter((key) => {
              if (key === props.xAxisKey) return false;
              const value = props.data![0][key];
              return typeof value === "number";
            })
          : [];

    if (!effectiveCategories.length) return {};

    const config: ChartConfig = {};
    effectiveCategories.forEach((key, index) => {
      const sanitizedKey = sanitizeForCssVar(key);
      const label = props.seriesLabels?.[key] || key;
      const color = fixColorFormat(
        props.colors?.[index] || `var(--chart-${(index % 5) + 1})`,
      );

      config[sanitizedKey] = {
        label,
        color,
      };
    });

    return config;
  }, [
    props.categories,
    props.seriesLabels,
    props.colors,
    props.data,
    props.xAxisKey,
  ]);

  const keyMapping = React.useMemo(() => {
    const effectiveCategories =
      props.categories && props.categories.length > 0
        ? props.categories
        : props.data && props.data.length > 0
          ? Object.keys(props.data[0]).filter((key) => {
              if (key === props.xAxisKey) return false;
              const value = props.data![0][key];
              return typeof value === "number";
            })
          : [];

    return effectiveCategories.length > 0
      ? createKeyMapping(
          Object.fromEntries(effectiveCategories.map((k) => [k, { label: k }])),
        )
      : new Map();
  }, [props.categories, props.data, props.xAxisKey]);

  const hasData = Array.isArray(props.data) && props.data?.length;

  return (
    <ChartContainer
      {...props}
      className={cn("h-full w-full pt-4 pb-4 pr-4", className)}
      config={chartConfig}
    >
      {hasData ? (
        <LineChartComponent
          data={props.data}
          onClick={props.onDataClick}
          accessibilityLayer
        >
          {props.gridStyle !== "hidden" && (
            <CartesianGrid
              vertical={false}
              strokeDasharray={props.gridStyle === "dashed" ? "3 3" : "0"}
            />
          )}

          {props.showXAxis && (
            <XAxis
              dataKey={props.xAxisKey}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
            />
          )}

          {props.showYAxis && (
            <YAxis tickLine={false} axisLine={false} tickMargin={8} />
          )}

          {props.showTooltip && (
            <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
          )}

          {props.showLegend && <ChartLegend content={<ChartLegendContent />} />}

          {Object.keys(chartConfig).map((key) => {
            const originalKey = keyMapping.get(key) || key;
            const wouldHideLine = props.strokeWidth === 0;

            return (
              <Line
                key={key}
                dataKey={originalKey}
                type={props.lineType}
                stroke={`var(--color-${key})`}
                {...(!wouldHideLine && { strokeWidth: props.strokeWidth })}
                connectNulls={props.connectNulls}
                isAnimationActive={props.enableAnimation}
                dot={
                  props.showDots
                    ? {
                        fill: `var(--color-${key})`,
                        strokeWidth: 2,
                        r: 2,
                      }
                    : false
                }
                activeDot={{
                  fill: `var(--color-${key})`,
                  strokeWidth: 2,
                  r: 4,
                }}
              >
                {props.showPointLabels && (
                  <LabelList
                    dataKey={originalKey}
                    position="top"
                    offset={10}
                    className="fill-foreground font-semibold text-xs"
                  />
                )}
              </Line>
            );
          })}
        </LineChartComponent>
      ) : (
        <div className="flex items-center justify-center h-full w-full min-h-32 text-muted-foreground">
          No data available
        </div>
      )}
    </ChartContainer>
  );
};

registerComponent(LineChart, {
  general: Section.category(PropsCategory.Content).children({
    data: Prop.array<any>()
      .propertiesPanel({
        label: "Data",
        description: "Array of data objects for the line chart",
        controlType: "FUNCTION_CODE_EDITOR",
        isJSConvertible: false,
      })
      .docs({
        description:
          "Array of objects where each object represents a data point with X-axis and Y-axis values. Each object should contain the xAxisKey property and properties for each data series defined in categories. Example: [{month: 'January', desktop: 186, mobile: 80}, {month: 'February', desktop: 305, mobile: 200}]. Multiple Y-value properties create multiple line series that can be styled independently.",
      }),
    xAxisKey: Prop.string()
      .propertiesPanel({
        label: "X-axis data key",
        description: " name for X-axis values (categories)",
        placeholder: "month",
        controlType: "DROP_DOWN",
        options: function (this) {
          if (!this.data || !Array.isArray(this.data) || !this.data.length) {
            return [];
          }
          return Object.keys(this.data[0]).map((key) => ({
            label: key,
            value: key,
          }));
        },
      })
      .docs({
        description:
          "The property name in your data objects that contains the X-axis values (categories, dates, or sequential values). This determines the horizontal positioning and connection order of data points along the line. Should be consistent across all data objects.",
      }),
    categories: Prop.array<string>()
      .propertiesPanel({
        label: "Categories",
        description:
          "Array of data keys to plot as line series (optional, auto-detects numeric properties if not provided)",
        controlType: "FUNCTION_CODE_EDITOR",
        isJSConvertible: false,
      })
      .docs({
        description:
          "Array of property names from your data objects to plot as separate line series. Example: ['desktop', 'mobile'] will create two line series. Each category should correspond to a numeric property in your data. If not provided, automatically detects all numeric properties (excluding xAxisKey) from the data.",
      }),
    seriesLabels: Prop.any<Record<string, string>>()
      .propertiesPanel({
        label: "Series labels",
        description:
          "Optional labels for series (optional, defaults to category names)",
        controlType: "FUNCTION_CODE_EDITOR",
        isJSConvertible: false,
      })
      .docs({
        description:
          "Optional object mapping category keys to display labels. Example: {desktop: 'Desktop Users', mobile: 'Mobile Users'}. If not provided, the category keys are used as labels.",
      }),
    colors: Prop.array<string>()
      .propertiesPanel({
        label: "Colors",
        description: "Array of colors for series (optional)",
        controlType: "FUNCTION_CODE_EDITOR",
        isJSConvertible: false,
      })
      .docs({
        description:
          "Optional array of color values to use for series in order. Can be hex codes, rgb values, or CSS variables like 'var(--chart-1)'. Falls back to theme colors if not provided.",
      }),
  }),
  appearance: Section.category(PropsCategory.Appearance).children({
    gridStyle: Prop.string<"solid" | "dashed" | "hidden">().propertiesPanel({
      label: "Grid style",
      description: "Style of the chart grid lines",
      controlType: "DROP_DOWN",
      options: [
        { label: "Solid", value: "solid" },
        { label: "Dashed", value: "dashed" },
        { label: "Hidden", value: "hidden" },
      ],
    }),
    showXAxis: Prop.boolean().propertiesPanel({
      label: "Show X-axis",
      description: "Display X-axis with labels",
      controlType: "SWITCH",
    }),
    showYAxis: Prop.boolean().propertiesPanel({
      label: "Show Y-axis",
      description: "Display Y-axis with labels",
      controlType: "SWITCH",
    }),
    showTooltip: Prop.boolean().propertiesPanel({
      label: "Show tooltip",
      description: "Display tooltip on hover",
      controlType: "SWITCH",
    }),
    showLegend: Prop.boolean().propertiesPanel({
      label: "Show legend",
      description: "Display chart legend",
      controlType: "SWITCH",
    }),
    showPointLabels: Prop.boolean().propertiesPanel({
      label: "Show point labels",
      description: "Display labels on data points",
      controlType: "SWITCH",
    }),
    strokeWidth: Prop.number().propertiesPanel({
      label: "Stroke width",
      description: "Width of the line stroke",
    }),
    showDots: Prop.boolean().propertiesPanel({
      label: "Show dots",
      description: "Display dots on the line at data points",
      controlType: "SWITCH",
    }),
    connectNulls: Prop.boolean().propertiesPanel({
      label: "Connect nulls",
      description: "Connect nulls with the previous non-null value",
      controlType: "SWITCH",
    }),
    lineType: Prop.string<
      | "linear"
      | "bump"
      | "step"
      | "basis"
      | "stepBefore"
      | "stepAfter"
      | "natural"
      | "monotone"
    >()
      .propertiesPanel({
        label: "Line type",
        description: "Type of line to display",
        controlType: "DROP_DOWN",
        options: [
          { label: "Linear", value: "linear" },
          { label: "Bump", value: "bump" },
          { label: "Step", value: "step" },
          { label: "Basis", value: "basis" },
          { label: "Step Before", value: "stepBefore" },
          { label: "Step After", value: "stepAfter" },
          { label: "Natural", value: "natural" },
          { label: "Monotone", value: "monotone" },
        ],
      })
      .docs({
        description:
          "Curve interpolation type for line paths. 'linear' creates straight line segments between points, 'monotone' creates smooth curves that preserve monotonicity (no overshooting), 'natural' creates natural spline curves for smoothest appearance, 'step' creates step functions with sharp transitions, 'basis' creates B-spline curves, 'bump' creates rounded transitions, 'stepBefore' steps before each point, 'stepAfter' steps after each point. Choose 'monotone' for smooth data trends, 'linear' for precise point-to-point connections.",
      }),
  }),
  interaction: Section.category(PropsCategory.Interaction).children({
    enableAnimation: Prop.boolean().propertiesPanel({
      label: "Enable animation",
      description: "Enable chart animations on load",
      controlType: "SWITCH",
    }),
  }),
  events: Section.category(PropsCategory.EventHandlers).children({
    onDataClick: Prop.eventHandler().propertiesPanel({
      label: "onDataClick",
      description: "Triggered when a line is clicked",
      computedArgs: [
        {
          name: "data",
          type: "object",
          description: "The data point that was clicked",
        },
      ],
    }),
  }),
}).editorConfig({ icon: "chart" });

export { LineChart };
