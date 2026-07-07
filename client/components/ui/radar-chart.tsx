import React from "react";
import {
  RadarChart as RadarChartComponent,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
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
  categoryKey?: string;
  categories?: string[];
  seriesLabels?: Record<string, string>;
  colors?: string[];
  showGrid?: boolean;
  gridType?: "circle" | "polygon";
  showAngleAxis?: boolean;
  showRadiusAxis?: boolean;
  radiusAxisTickCount?: number;
  radiusDomain?: [number, number | "auto"];
  showTooltip?: boolean;
  showLegend?: boolean;
  fillRadar?: boolean;
  fillOpacity?: number;
  strokeWidth?: number;
  enableAnimation?: boolean;
  showDots?: boolean;
  dotSize?: number;
  showPointLabels?: boolean;
  onDataClick?: (data: any) => void;
};

const RadarChart = ({ className, ...props }: ComponentProps) => {
  const chartConfig: ChartConfig = React.useMemo(() => {
    const effectiveCategories =
      props.categories && props.categories.length > 0
        ? props.categories
        : props.data && props.data.length > 0
          ? Object.keys(props.data[0]).filter((key) => {
              if (key === props.categoryKey) return false;
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
    props.categoryKey,
  ]);

  const keyMapping = React.useMemo(() => {
    const effectiveCategories =
      props.categories && props.categories.length > 0
        ? props.categories
        : props.data && props.data.length > 0
          ? Object.keys(props.data[0]).filter((key) => {
              if (key === props.categoryKey) return false;
              const value = props.data![0][key];
              return typeof value === "number";
            })
          : [];

    return effectiveCategories.length > 0
      ? createKeyMapping(
          Object.fromEntries(effectiveCategories.map((k) => [k, { label: k }])),
        )
      : new Map();
  }, [props.categories, props.data, props.categoryKey]);

  const hasData = Array.isArray(props.data) && props.data?.length;

  return (
    <ChartContainer
      className={cn("h-full w-full pt-4 pb-4 pr-4", className)}
      {...props}
      config={chartConfig}
    >
      {hasData ? (
        <RadarChartComponent
          data={props.data}
          onClick={props.onDataClick}
          accessibilityLayer
        >
          {props.showGrid && (
            <PolarGrid
              gridType={props.gridType === "circle" ? "circle" : "polygon"}
            />
          )}
          {props.showAngleAxis && (
            <PolarAngleAxis
              dataKey={props.categoryKey}
              tickLine={false}
              className="text-xs"
            />
          )}
          {props.showRadiusAxis && (
            <PolarRadiusAxis
              tickCount={props.radiusAxisTickCount}
              domain={props.radiusDomain || [0, "auto"]}
              tickLine={false}
              axisLine={false}
              className="text-xs"
            />
          )}
          {props.showTooltip && (
            <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
          )}
          {props.showLegend && <ChartLegend content={<ChartLegendContent />} />}
          {Object.keys(chartConfig).map((key) => {
            const originalKey = keyMapping.get(key) || key;
            const effectiveFillOpacity = props.fillRadar
              ? props.fillOpacity
              : 0;
            const wouldHideChart =
              props.fillOpacity === 0 && props.strokeWidth === 0;

            return (
              <Radar
                key={key}
                name={(chartConfig[key]?.label as string) || key}
                dataKey={originalKey}
                stroke={`var(--color-${key})`}
                fill={props.fillRadar ? `var(--color-${key})` : "none"}
                {...(!wouldHideChart && { fillOpacity: effectiveFillOpacity })}
                {...(!wouldHideChart && { strokeWidth: props.strokeWidth })}
                isAnimationActive={props.enableAnimation}
                dot={
                  props.showDots
                    ? {
                        fillOpacity: 1,
                        fill: `var(--color-${key})`,
                        r: props.dotSize,
                      }
                    : false
                }
                label={
                  props.showPointLabels
                    ? { className: "fill-foreground text-xs font-medium" }
                    : false
                }
              />
            );
          })}
        </RadarChartComponent>
      ) : (
        <div className="flex items-center justify-center h-full w-full min-h-32 text-muted-foreground">
          No data available
        </div>
      )}
    </ChartContainer>
  );
};

registerComponent(RadarChart, {
  general: Section.category(PropsCategory.Content).children({
    data: Prop.array<any>()
      .propertiesPanel({
        label: "Data",
        description: "Array of data objects for the radar chart",
        controlType: "FUNCTION_CODE_EDITOR",
        isJSConvertible: false,
      })
      .docs({
        description:
          "Array of objects where each object represents a radar point with category and value data. Each object should contain the categoryKey property and properties for each data series defined in categories. Radar charts are ideal for multi-dimensional data comparison. Example: [{category: 'Speed', performance: 85, quality: 78}, {category: 'Efficiency', performance: 92, quality: 85}]. Multiple value properties create multiple overlapping radar shapes for comparison.",
      }),
    categoryKey: Prop.string()
      .propertiesPanel({
        label: "Category data key",
        description: " name for category/axis labels",
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
          "The property name in your data objects that contains the category labels for each radar axis point. These categories form the angular (perimeter) axis of the radar chart, with labels positioned around the circle. Should represent the dimensions or criteria being measured (e.g., 'Speed', 'Quality', 'Price').",
      }),
    categories: Prop.array<string>()
      .propertiesPanel({
        label: "Categories",
        description:
          "Array of data keys to plot as radar series (optional, auto-detects numeric properties if not provided)",
        controlType: "FUNCTION_CODE_EDITOR",
        isJSConvertible: false,
      })
      .docs({
        description:
          "Array of property names from your data objects to plot as separate radar series. Example: ['performance', 'quality'] will create two overlapping radar shapes. Each category should correspond to a numeric property in your data. If not provided, automatically detects all numeric properties (excluding categoryKey) from the data.",
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
          "Optional object mapping category keys to display labels. Example: {performance: 'Performance Score', quality: 'Quality Score'}. If not provided, the category keys are used as labels.",
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
    showGrid: Prop.boolean().propertiesPanel({
      label: "Show grid",
      description: "Display chart grid lines",
      controlType: "SWITCH",
    }),
    gridType: Prop.string<"polygon" | "circle">()
      .propertiesPanel({
        isVisible: function (this: any) {
          return this.showGrid;
        },
        label: "Grid type",
        description: "Type of grid to display",
        controlType: "DROP_DOWN",
        options: [
          { label: "Polygon", value: "polygon" },
          { label: "Circle", value: "circle" },
        ],
      })
      .docs({
        description:
          "Visual style of the radar grid. 'polygon' creates straight-line grid segments connecting angular points (traditional radar appearance). 'circle' creates concentric circular grid lines. Polygon grids emphasize the multi-dimensional nature of data, while circular grids provide smoother visual flow.",
      }),
    showAngleAxis: Prop.boolean().propertiesPanel({
      label: "Show angle axis",
      description: "Display category labels around the perimeter",
      controlType: "SWITCH",
    }),
    showRadiusAxis: Prop.boolean().propertiesPanel({
      label: "Show radius axis",
      description: "Display radial axis with value labels",
      controlType: "SWITCH",
    }),
    radiusAxisTickCount: Prop.number().propertiesPanel({
      label: "Radius axis tick count",
      description: "Number of tick marks on radius axis",
      isVisible: function (this: any) {
        return this.showRadiusAxis;
      },
    }),
    radiusDomain: Prop.any<[number, number | "auto"]>()
      .propertiesPanel({
        label: "Radius domain",
        description:
          "Min and max values for radius axis (e.g., [0, 100] or [0, 'auto'])",
        controlType: "FUNCTION_CODE_EDITOR",
        isJSConvertible: false,
      })
      .docs({
        description:
          "Range of values for the radial (distance from center) axis. Array with [min, max] values. Use numbers for fixed ranges like [0, 100] for percentage scales, or [0, 'auto'] to automatically determine maximum based on data. The radial axis determines how far each data point extends from the center.",
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
    fillRadar: Prop.boolean().propertiesPanel({
      label: "Fill radar",
      description: "Fill the radar areas with color",
      controlType: "SWITCH",
    }),
    fillOpacity: Prop.number().propertiesPanel({
      label: "Fill opacity",
      description: "Opacity of the radar fill (0-1)",
      isVisible: function (this: any) {
        return this.fillRadar;
      },
    }),
    strokeWidth: Prop.number().propertiesPanel({
      label: "Stroke width",
      description: "Width of the radar stroke lines",
    }),
    showDots: Prop.boolean().propertiesPanel({
      label: "Show dots",
      description: "Display dots at data points",
      controlType: "SWITCH",
    }),
    dotSize: Prop.number().propertiesPanel({
      label: "Dot size",
      description: "Size of dots at data points",
      isVisible: function (this: any) {
        return this.showDots;
      },
    }),
    showPointLabels: Prop.boolean().propertiesPanel({
      label: "Show point labels",
      description: "Display value labels at data points",
      controlType: "SWITCH",
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
      description: "Triggered when a radar segment is clicked",
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

export { RadarChart };
