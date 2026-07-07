/* eslint-disable react-refresh/only-export-components */
import * as TogglePrimitive from "@radix-ui/react-toggle";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import {
  registerComponent,
  Prop,
  Section,
  PropsCategory,
  type PropertiesPanelDefinition,
  type EditorConfig,
} from "@superblocksteam/library";

import { cn } from "@/lib/utils";

// Variants
const toggleVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium hover:bg-muted hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none transition-[color,box-shadow] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline:
          "border border-input bg-transparent shadow-xs hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        default: "h-9 px-2 min-w-9",
        sm: "h-8 px-1.5 min-w-8",
        lg: "h-10 px-2.5 min-w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

// Toggle Component
type ToggleProps = React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants>;

function Toggle({ className, variant, size, ...props }: ToggleProps) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<ToggleProps> = {
  general: Section.category(PropsCategory.Content).children({
    pressed: Prop.boolean().propertiesPanel({
      label: "Pressed",
      controlType: "SWITCH",
      description:
        "The controlled pressed state of the toggle. Must be used in conjunction with `onPressedChange`",
      isRemovable: true,
      visibility: "SHOW_NAME",
    }),
    children: Prop.jsx().propertiesPanel({
      label: "Text",
      description: "The text content of the toggle button",
    }),
    defaultPressed: Prop.boolean()
      .propertiesPanel({
        label: "Default pressed",
        controlType: "SWITCH",
        description: "Whether the toggle is pressed by default",
      })
      .docs({
        description: "Use when you do not need to control its pressed state",
      }),
  }),

  appearance: Section.category(PropsCategory.Appearance).children({
    variant: Prop.string<"default" | "outline">().propertiesPanel({
      label: "Variant",
      controlType: "DROP_DOWN",
      description: "Visual style variant of the toggle",
      options: [
        {
          label: "Default",
          value: "default",
        },
        {
          label: "Outline",
          value: "outline",
        },
      ],
    }),
    size: Prop.string<"default" | "sm" | "lg">().propertiesPanel({
      label: "Size",
      controlType: "DROP_DOWN",
      description: "Size variant of the toggle",
      options: [
        {
          label: "Small",
          value: "sm",
        },
        {
          label: "Default",
          value: "default",
        },
        {
          label: "Large",
          value: "lg",
        },
      ],
    }),
  }),

  interaction: Section.category(PropsCategory.Interaction).children({
    disabled: Prop.boolean().propertiesPanel({
      label: "Disabled",
      controlType: "SWITCH",
      description: "Whether the toggle is disabled",
    }),
  }),

  events: Section.category(PropsCategory.EventHandlers).children({
    onPressedChange: Prop.eventHandler().propertiesPanel({
      label: "onPressedChange",
      description: "Triggered when the toggle pressed state changes",
      computedArgs: [
        {
          name: "pressed",
          type: "boolean",
          description: "Whether the toggle is pressed",
        },
      ],
    }),
  }),
};

// Editor Configuration
const editorConfig: EditorConfig = {
  icon: "switch",
  description: "A two-state button that can be either on or off",
  isDroppable: false,
};

// Registration
registerComponent(Toggle, propertiesDefinition).editorConfig(editorConfig);

export { Toggle, toggleVariants };
