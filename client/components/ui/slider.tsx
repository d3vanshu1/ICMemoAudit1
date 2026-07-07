import * as SliderPrimitive from "@radix-ui/react-slider";
import * as React from "react";

import { registerComponent } from "@superblocksteam/library";
import {
  Prop,
  Section,
  PropsCategory,
  type PropertiesPanelDefinition,
  type EditorConfig,
} from "@superblocksteam/library";

import { cn } from "@/lib/utils";

// Main Component
function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  const _values = React.useMemo(
    () =>
      Array.isArray(value)
        ? value
        : Array.isArray(defaultValue)
          ? defaultValue
          : [min, max],
    [value, defaultValue, min, max],
  );
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        "relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          "bg-muted relative grow overflow-hidden rounded-full data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5",
        )}
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn(
            "bg-primary absolute data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full",
          )}
        />
      </SliderPrimitive.Track>
      {Array.from(
        {
          length: _values.length,
        },
        (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            data-ignore-dnd="true"
            onClick={(e) => {
              e.stopPropagation();
            }}
            key={index}
            className="border-primary bg-background ring-ring/50 block size-4 shrink-0 rounded-full border shadow-sm transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
          />
        ),
      )}
    </SliderPrimitive.Root>
  );
}

// Types
// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<
  React.ComponentProps<typeof SliderPrimitive.Root>
> = {
  general: Section.category(PropsCategory.Content).children({
    value: Prop.array<number>().propertiesPanel({
      label: "Value",
      controlType: "INPUT_TEXT",
      description: "The controlled value of the slider",
      isRemovable: true,
      visibility: "SHOW_NAME",
    }),
    defaultValue: Prop.array<number>().propertiesPanel({
      label: "Default value",
      description:
        "The default selected option value. Changes to the default selection update the component state",
      placeholder: "Enter default option value",
    }),
    min: Prop.number().propertiesPanel({
      label: "Min value",
      description: "The minimum value of the slider",
      placeholder: "Enter min value",
      defaultOnAdd: 0,
      visibility: "SHOW_NAME",
      isRemovable: true,
    }),
    max: Prop.number().propertiesPanel({
      label: "Max value",
      description: "The maximum value of the slider",
      placeholder: "Enter max value",
      defaultOnAdd: 100,
      visibility: "SHOW_NAME",
      isRemovable: true,
    }),
    step: Prop.number().propertiesPanel({
      label: "Step value",
      description: "The step value of the slider",
      placeholder: "Enter step value",
      defaultOnAdd: 1,
      visibility: "SHOW_NAME",
      isRemovable: true,
    }),
    minStepsBetweenThumbs: Prop.number().propertiesPanel({
      label: "Min steps between thumbs",
      description: "The minimum number of steps between multiple thumbs",
      placeholder: "Enter minimum steps",
      defaultOnAdd: 0,
      visibility: "SHOW_NAME",
      isRemovable: true,
    }),
  }),
  appearance: Section.category(PropsCategory.Appearance).children({
    orientation: Prop.string<"horizontal" | "vertical">()

      .propertiesPanel({
        label: "Orientation",
        description: "The orientation of the slider",
        controlType: "RADIO_BUTTON_GROUP",
        options: [
          { value: "horizontal", label: "Horizontal" },
          { value: "vertical", label: "Vertical" },
        ],
        visibility: "SHOW_NAME",
        isRemovable: true,
        defaultOnAdd: "horizontal",
      }),
    inverted: Prop.boolean().propertiesPanel({
      label: "Inverted",
      description: "Whether the slider is inverted (reverse direction)",
      controlType: "SWITCH",
      visibility: "SHOW_NAME",
      isRemovable: true,
      defaultOnAdd: false,
    }),
  }),
  interaction: Section.category(PropsCategory.Interaction).children({
    disabled: Prop.boolean().propertiesPanel({
      label: "Disabled",
      description: "Disables user interaction with this component",
      controlType: "SWITCH",
    }),
  }),
  events: Section.category(PropsCategory.EventHandlers).children({
    onValueChange: Prop.eventHandler().propertiesPanel({
      label: "onValueChange",
      description: "Event handler called when the value changes",
      computedArgs: [
        {
          name: "value",
          type: "array",
          description: "The new value",
        },
      ],
    }),
    onValueCommit: Prop.eventHandler().propertiesPanel({
      label: "onValueCommit",
      description:
        "Event handler called when the value changes at the end of an interaction. Useful when you only need to capture a final value e.g. to update a backend service",
      computedArgs: [
        {
          name: "value",
          type: "array",
          description: "The new value",
        },
      ],
    }),
  }),
};

// Editor Configuration
const editorConfig: EditorConfig = {
  icon: "custom",
  hasExtendedClickArea: true,
};

// Registration
registerComponent(Slider, propertiesDefinition).editorConfig(editorConfig);

export { Slider };
