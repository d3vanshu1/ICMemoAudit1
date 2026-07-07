import React from "react";
import {
  BarChart as BarChartComponent,
  Bar,
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
  type EditorConfig,
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
  stackIds?: Record<string, string>;
  gridStyle?: "solid" | "dashed" | "hidden";
  showXAxis?: boolean;
  showYAxis?: boolean;
  showTooltip?: boolean;
  showLegend?: boolean;
  layout?: "horizontal" | "vertical";
  barSize?: number;
  stackOffset?: "expand" | "none" | "wiggle" | "silhouette";
  barRadius?: number | [number, number, number, number];
  showBarLabels?: boolean;
  enableAnimation?: boolean;
  onDataClick?: (data: any) => void;
};

const BarChart = ({ className, ...props }: ComponentProps) => {
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
      className={cn("h-full w-full pt-4 pb-4 pr-4", className)}
      {...props}
      config={chartConfig}
    >
      {hasData ? (
        <BarChartComponent
          data={props.data}
          onClick={props.onDataClick}
          accessibilityLayer
          layout={props.layout}
          barSize={props.barSize}
          stackOffset={props.stackOffset}
        >
          {props.gridStyle !== "hidden" && (
            <CartesianGrid
              vertical={props.layout === "horizontal"}
              strokeDasharray={props.gridStyle === "dashed" ? "3 3" : "0"}
            />
          )}

          {props.showXAxis && (
            <XAxis
              type={props.layout === "vertical" ? "number" : "category"}
              dataKey={props.layout === "vertical" ? undefined : props.xAxisKey}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
            />
          )}

          {props.showYAxis && (
            <YAxis
              type={props.layout === "vertical" ? "category" : "number"}
              dataKey={props.layout === "vertical" ? props.xAxisKey : undefined}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
            />
          )}

          {props.showTooltip && (
            <ChartTooltip
              cursor={{ fill: "rgba(0, 0, 0, 0.1)" }}
              content={<ChartTooltipContent />}
            />
          )}

          {props.showLegend && <ChartLegend content={<ChartLegendContent />} />}

          {Object.keys(chartConfig).map((key) => {
            const originalKey = keyMapping.get(key) || key;
            const stackId = props.stackIds?.[originalKey];
            return (
              <Bar
                key={key}
                dataKey={originalKey}
                fill={`var(--color-${key})`}
                radius={props.barRadius}
                stackId={stackId || undefined}
                isAnimationActive={props.enableAnimation}
              >
                {props.showBarLabels && (
                  <LabelList
                    dataKey={originalKey}
                    position={props.layout === "vertical" ? "right" : "top"}
                    className="fill-foreground font-semibold text-xs"
                  />
                )}
              </Bar>
            );
          })}
        </BarChartComponent>
      ) : (
        <div className="flex items-center justify-center h-full w-full min-h-32 text-muted-foreground">
          No data available
        </div>
      )}
    </ChartContainer>
  );
};

const properties = {
  general: Section.category(PropsCategory.Content).children({
    data: Prop.array<any>()
      .propertiesPanel({
        label: "Data",
        description: "Array of data objects for the bar chart",
        controlType: "FUNCTION_CODE_EDITOR",
        isJSConvertible: false,
      })
      .docs({
        description:
          "Array of objects where each object represents a category with X-axis value and Y-axis values for each data series. Each object should contain the xAxisKey property and properties for each bar series defined in categories. Example: [{month: 'January', desktop: 186, mobile: 80}, {month: 'February', desktop: 305, mobile: 200}]. Multiple Y-value properties create multiple bar series (grouped or stacked).",
      }),

    xAxisKey: Prop.string()
      .propertiesPanel({
        label: "X-axis data key",
        description: " name for X-axis values (categories)",
        placeholder: "category",
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
          "The property name in your data objects that contains the X-axis values (categories, labels, or identifiers). This determines the horizontal grouping of bars and should be consistent across all data objects.",
      }),

    categories: Prop.array<string>()
      .propertiesPanel({
        label: "Categories",
        description:
          "Array of data keys to plot as bar series (optional, auto-detects numeric properties if not provided)",
        controlType: "FUNCTION_CODE_EDITOR",
        isJSConvertible: false,
      })
      .docs({
        description:
          "Array of property names from your data objects to plot as separate bar series. Example: ['desktop', 'mobile'] will create two bar series. Each category should correspond to a numeric property in your data. If not provided, automatically detects all numeric properties (excluding xAxisKey) from the data.",
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

    stackIds: Prop.any<Record<string, string>>()
      .propertiesPanel({
        label: "Stack IDs",
        description: "Optional stack IDs for grouping bars (optional)",
        controlType: "FUNCTION_CODE_EDITOR",
        isJSConvertible: false,
      })
      .docs({
        description:
          "Optional object mapping category keys to stack IDs. Bars with the same stack ID will be stacked together. Example: {desktop: 'stack1', mobile: 'stack1'} stacks desktop and mobile bars.",
      }),
  }),
  appearance: Section.category(PropsCategory.Appearance).children({
    layout: Prop.string<"vertical" | "horizontal">()
      .propertiesPanel({
        label: "Layout",
        description: "Orientation of the bars",
        controlType: "DROP_DOWN",
        options: [
          { label: "Vertical", value: "vertical" },
          { label: "Horizontal", value: "horizontal" },
        ],
      })
      .docs({
        description:
          "Chart orientation. 'vertical' creates bars that extend upward from bottom (categories on X-axis, values on Y-axis). 'horizontal' creates bars that extend rightward from left (categories on Y-axis, values on X-axis). Layout affects axis configuration and bar positioning.",
      }),

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
    barSize: Prop.number().propertiesPanel({
      label: "Bar size",
      description: "Width/height of the bars",
      visibility: "SHOW_NAME",
      defaultOnAdd: 40,
    }),
    barRadius: Prop.number().propertiesPanel({
      label: "Bar radius",
      description: "Border radius of the bars for rounded corners",
      visibility: "SHOW_NAME",
      defaultOnAdd: 0,
    }),
    showBarLabels: Prop.boolean().propertiesPanel({
      label: "Show bar labels",
      description: "Display value labels on bars",
      controlType: "SWITCH",
    }),
    stackOffset: Prop.string<"none" | "expand">()
      .propertiesPanel({
        label: "Stack offset",
        description: "Type of stacking for multiple series (expand = 100%)",
        controlType: "DROP_DOWN",
        options: [
          { label: "None", value: "none" },
          { label: "Expand (100%)", value: "expand" },
        ],
      })
      .docs({
        description:
          "Stacking behavior for bars with matching stackId. 'none' shows actual values with bars stacked to their natural heights. 'expand' normalizes all stacked bars to 100% height, showing relative proportions rather than absolute values. Only affects bars that share the same stackId.",
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
      description: "Triggered when a bar is clicked",
      computedArgs: [
        {
          name: "data",
          type: "object",
          description: "The data point that was clicked",
        },
      ],
    }),
  }),
};

const editorConfig: EditorConfig = {
  icon: "chart",
};

registerComponent(BarChart, properties).editorConfig(editorConfig);

export { BarChart };
