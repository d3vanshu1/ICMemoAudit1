import * as SwitchPrimitives from "@radix-ui/react-switch";
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
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

// Types
// Properties Definition
const propertiesDefinition: PropertiesPanelDefinition<
  React.ComponentProps<typeof SwitchPrimitives.Root>
> = {
  general: Section.category(PropsCategory.Content).children({
    checked: Prop.boolean().propertiesPanel({
      label: "Checked",
      controlType: "SWITCH",
      description:
        "The controlled state of the switch. Must be used in conjunction with `onCheckedChange`",
      isRemovable: true,
      visibility: "SHOW_NAME",
    }),
    defaultChecked: Prop.boolean()
      .propertiesPanel({
        label: "Default checked",
        controlType: "SWITCH",
        description: "Whether the switch is checked by default",
      })
      .docs({
        description: "Use when you do not need to control its pressed state",
      }),
  }),

  interaction: Section.category(PropsCategory.Interaction).children({
    disabled: Prop.boolean().propertiesPanel({
      label: "Disabled",
      controlType: "SWITCH",
      description: "Whether the switch is disabled",
    }),
  }),

  events: Section.category(PropsCategory.EventHandlers).children({
    onCheckedChange: Prop.eventHandler().propertiesPanel({
      label: "onChange",
      description: "Triggered when the switch checked state changes",
      computedArgs: [
        {
          name: "checked",
          type: "boolean",
          description: "Whether the switch is checked",
        },
      ],
    }),
  }),
};

// Editor Configuration
const editorConfig: EditorConfig = {
  icon: "switch",
  description:
    "A control that allows the user to toggle between checked and not checked",
};

// Registration
registerComponent(Switch, propertiesDefinition).editorConfig(editorConfig);

export { Switch };
