import React from "react";
import {
  RadialBarChart as RadialBarChartComponent,
  RadialBar,
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
} from "./chart";

type ComponentProps = Omit<
  React.ComponentPropsWithoutRef<typeof ChartContainer>,
  "children" | "config"
> & {
  data?: any[];
  valueKey?: string;
  nameKey?: string;
  labelKey?: string;
  colorKey?: string;
  colors?: string[];
  chartType?: "single" | "stacked";
  startAngle?: number;
  endAngle?: number;
  innerRadius?: number | string;
  cornerRadius?: number;
  enableAnimation?: boolean;
  showBarLabels?: boolean;
  showTooltip?: boolean;
  showLegend?: boolean;
  showCenterLabel?: boolean;
  labelText?: string;
  labelSubtext?: string;
  onDataClick?: (data: any) => void;
};

const RadialBarChart = ({ className, ...props }: ComponentProps) => {
  const valueKey = props.valueKey || "value";
  const nameKey = props.nameKey || "name";

  const chartConfig: ChartConfig = React.useMemo(() => {
    if (!props.data || !Array.isArray(props.data)) return {};

    const config: ChartConfig = {};
    props.data.forEach((item, index) => {
      const nameValue = item[nameKey];
      const labelValue = props.labelKey ? item[props.labelKey] : nameValue;
      const sanitizedName = sanitizeForCssVar(nameValue);

      // Get color from: 1) data item colorKey, 2) colors array, 3) default theme color
      const itemColor = props.colorKey ? item[props.colorKey] : undefined;
      const color = fixColorFormat(
        itemColor || props.colors?.[index] || `var(--chart-${(index % 5) + 1})`,
      );

      config[sanitizedName] = {
        label: labelValue,
        color,
      };
    });
    return config;
  }, [props.data, nameKey, props.labelKey, props.colorKey, props.colors]);

  const chartData = React.useMemo(() => {
    return props.data?.map((item) => {
      const nameValue = item[nameKey];
      const sanitizedName = sanitizeForCssVar(nameValue);

      const fillColor = chartConfig[sanitizedName]
        ? `var(--color-${sanitizedName})`
        : "var(--chart-1)";

      return {
        ...item,
        fill: fillColor,
      };
    });
  }, [props.data, nameKey, chartConfig]);

  const totalValue = React.useMemo(() => {
    if (!Array.isArray(props.data) || !props.data?.length || !props.valueKey)
      return 0;
    if (props.chartType === "single") {
      return props.data[0]?.[props.valueKey] || 0;
    } else {
      return props.data.reduce((sum, item) => {
        const value = typeof item[valueKey] === "number" ? item[valueKey] : 0;
        return sum + value;
      }, 0);
    }
  }, [props.data, props.valueKey, props.chartType, valueKey]);

  const hasData = Array.isArray(props.data) && props.data?.length;

  return (
    <ChartContainer
      className={cn("h-full w-full", className)}
      {...props}
      config={chartConfig}
    >
      {hasData ? (
        <RadialBarChartComponent
          data={chartData}
          startAngle={props.startAngle}
          endAngle={props.endAngle}
          innerRadius={props.innerRadius}
          onClick={props.onDataClick}
          accessibilityLayer
        >
          {props.showTooltip && (
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent nameKey={props.nameKey} />}
            />
          )}
          {props.showLegend && (
            <ChartLegend
              content={<ChartLegendContent nameKey={props.nameKey} />}
            />
          )}
          <RadialBar
            dataKey={valueKey}
            background
            cornerRadius={props.cornerRadius}
            isAnimationActive={props.enableAnimation}
          >
            {props.showBarLabels && (
              <LabelList
                position="insideStart"
                dataKey={nameKey}
                className="fill-white capitalize mix-blend-luminosity"
                fontSize={11}
              />
            )}
          </RadialBar>
          {props.showCenterLabel && (
            <text
              x="50%"
              y="50%"
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-foreground"
            >
              <tspan x="50%" dy="-0.5em" className="text-2xl font-bold">
                {props.labelText || totalValue.toLocaleString()}
              </tspan>
              {props.labelSubtext && (
                <tspan
                  x="50%"
                  dy="1.2em"
                  className="fill-muted-foreground text-sm"
                >
                  {props.labelSubtext}
                </tspan>
              )}
            </text>
          )}
        </RadialBarChartComponent>
      ) : (
        <div className="flex items-center justify-center h-full w-full min-h-32 text-muted-foreground">
          No data available
        </div>
      )}
    </ChartContainer>
  );
};

registerComponent(RadialBarChart, {
  general: Section.category(PropsCategory.Content).children({
    data: Prop.array<any>()
      .propertiesPanel({
        label: "Data",
        description: "Array of data objects for the radial chart",
        controlType: "FUNCTION_CODE_EDITOR",
        isJSConvertible: false,
      })
      .docs({
        description:
          "Array of objects for circular bar visualization. For single radial charts, typically contains one object with category name and value. For stacked radial charts, contains multiple objects representing concentric bars. Example: [{browser: 'Chrome', visitors: 275, color: '#4285F4'}, {browser: 'Safari', visitors: 200}]. Values are often percentages or progress indicators displayed as arc lengths.",
      }),
    valueKey: Prop.string()
      .propertiesPanel({
        label: "Value data key",
        description: " name for the values to display",
        placeholder: "value",
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
          "The property name in your data objects that contains the numeric values determining arc lengths. Values typically represent percentages (0-100), progress (0-1), or absolute numbers that will be proportionally rendered as circular arcs from startAngle to calculated end positions.",
      }),
    nameKey: Prop.string()
      .propertiesPanel({
        label: "Name data key",
        description: " name for category names/identifiers",
        placeholder: "name",
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
          "The property name in your data objects that contains unique identifiers for each bar. Used to generate consistent colors and match data across renders.",
      }),
    labelKey: Prop.string()
      .propertiesPanel({
        label: "Label data key",
        description: " name for display labels (optional, defaults to nameKey)",
        placeholder: "label",
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
          "Optional property name for human-readable labels shown in tooltips and legends. If not specified, the nameKey value is used as the label.",
      }),
    colorKey: Prop.string()
      .propertiesPanel({
        label: "Color data key",
        description: " name for bar colors (optional)",
        placeholder: "color",
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
          "Optional property name in your data objects that contains color values (hex, rgb, or CSS variable). If not specified, colors are auto-assigned from the theme.",
      }),
    colors: Prop.array<string>()
      .propertiesPanel({
        label: "Colors",
        description: "Array of colors to use for bars (optional)",
        controlType: "FUNCTION_CODE_EDITOR",
        isJSConvertible: false,
      })
      .docs({
        description:
          "Optional array of color values to use for bars in order. Can be hex codes, rgb values, or CSS variables like 'var(--chart-1)'. Falls back to theme colors if not provided.",
      }),
  }),
  appearance: Section.category(PropsCategory.Appearance).children({
    chartType: Prop.string<"single" | "stacked">()
      .propertiesPanel({
        label: "Chart type",
        description: "Type of radial chart to display",
        controlType: "DROP_DOWN",
        options: [
          { label: "Single", value: "single" },
          { label: "Stacked", value: "stacked" },
        ],
      })
      .docs({
        description:
          "Visual layout of the radial chart. 'single' displays one circular bar (ideal for progress indicators, gauges, or single metrics). 'stacked' displays multiple concentric circular bars (ideal for comparing multiple categories or showing layered data). Single charts often show one data point, while stacked charts display multiple data points as concentric arcs.",
      }),
    startAngle: Prop.number()
      .propertiesPanel({
        label: "Start angle",
        description: "Starting angle of the radial chart in degrees",
      })
      .docs({
        description:
          "Starting position of the radial bars in degrees. 0° = 3 o'clock (right), 90° = 12 o'clock (top), 180° = 9 o'clock (left), 270° = 6 o'clock (bottom). Common values: 90° for top-start, 180° for left-start. Determines where the arc begins drawing. For a single radial chart showing percentage, use start and end angles to control the arc range to show a percentage of the total.",
      }),
    endAngle: Prop.number()
      .propertiesPanel({
        label: "End angle",
        description: "Ending angle of the radial chart in degrees",
      })
      .docs({
        description:
          "Ending position of the radial bars in degrees, defining the full arc sweep. Negative values create clockwise motion. Common combinations: startAngle 90° + endAngle -270° = full circle clockwise from top. startAngle 180° + endAngle 0° = semicircle left to right. The difference determines the total arc range for 100% values.",
      }),
    innerRadius: Prop.number()
      .propertiesPanel({
        label: "Inner radius",
        description: "Inner radius of the radial chart",
      })
      .docs({
        description:
          "Size of the hollow center area in pixels or percentage. Creates the donut-like appearance. Larger values create bigger center areas (useful for center labels). Smaller values create thicker bars. For stacked charts, determines the starting radius of the innermost bar.",
      }),
    cornerRadius: Prop.number().propertiesPanel({
      label: "Corner radius",
      description: "Radius of rounded corners on bars",
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
    showBarLabels: Prop.boolean().propertiesPanel({
      label: "Show bar labels",
      description: "Display labels on the bars",
      controlType: "SWITCH",
    }),
    showCenterLabel: Prop.boolean().propertiesPanel({
      label: "Show center label",
      description: "Display label in the center of the chart",
      controlType: "SWITCH",
    }),
    labelText: Prop.string()
      .propertiesPanel({
        label: "Label text",
        description: "Custom text to display in center (leave empty for auto)",
        isVisible: function (this: any) {
          return this.showCenterLabel;
        },
      })
      .docs({
        description:
          "Custom text for center label. If empty, automatically displays calculated total (sum for stacked, first value for single). Useful for custom metrics, percentages with % symbols, or descriptive text. Displayed with large, bold styling.",
      }),
    labelSubtext: Prop.string()
      .propertiesPanel({
        label: "Label subtext",
        description: "Subtext to display below main label",
        isVisible: function (this: any) {
          return this.showCenterLabel;
        },
      })
      .docs({
        description:
          "Secondary text displayed below the main center label with smaller, muted styling. Typically used for units, descriptions, or context like 'completion', 'users', 'progress', etc. Positioned below the main label for hierarchical information display.",
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
      description: "Triggered when a radial segment is clicked",
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

export { RadialBarChart };
